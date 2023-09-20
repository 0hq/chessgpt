'use client'

import { Chess, ChessInstance, Move, ShortMove, Square } from "chess.js";
import { useEffect, useRef, useState } from "react";
import { Chessboard } from "react-chessboard";
import OpenAI from 'openai';
import { Piece } from "react-chessboard/dist/chessboard/types";
import Script from 'next/script'
import { EngineWrapper } from "./stockfish/EngineWrapper"

const DEFAULT_USER_PROMPT = '[Event \"FIDE World Cup 2023\"]\n[Site \"Baku AZE\"]\n[Date \"2023.08.23\"]\n[EventDate \"2021.07.30\"]\n[Round \"8.2\"]\n[Result \"1/2-1/2\"]\n[White \"Magnus Carlsen\"]\n[Black \"Rameshbabu Praggnanandhaa\"]\n[ECO \"C48\"]\n[WhiteElo \"2835\"]\n[BlackElo \"2690\"]\n[PlyCount \"60\"]\n\n'
const DEFAULT_SYSTEM_PROMPT = 'You are a Chess grandmaster that helps analyze and predict live chess games. Given the algebraic notation for a given match, predict the next move. Do not return anything except for the algebraic notation for your prediction.'
const DEFAULT_MODEL: Model = 'gpt-3.5-turbo-instruct'
const DEFAULT_MODEL_2: Model = 'stockfish-3'
const STOCKFISH_THREADS = 2

type CompletionModel = 'gpt-3.5-turbo-instruct' // 'gpt-4-base' -> https://openai.com/careers/
type ChatModel = 'gpt-4' | 'gpt-3.5-turbo'
type LLModel = CompletionModel | ChatModel
type StockfishModel = `stockfish-${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19 | 20}`

type Model = LLModel | StockfishModel

const useChatCompletions = {
  'gpt-4': true,
  'gpt-3.5-turbo': true,
  'gpt-3.5-turbo-instruct': false
}

let modelOptions = {
  'gpt-3.5-turbo-instruct': "GPT-3.5 Turbo Completions",
  'gpt-4': "GPT-4",
  'gpt-3.5-turbo': "GPT-3.5 Turbo",
} as {[K in Model]: string}
for (let i = 1; i <= 20; i++) {
  modelOptions[`stockfish-${i}` as StockfishModel] = `Stockfish ${i}`
}

let openai: OpenAI;

// potentially need two engines to support stockfish self-play at different skill levels
const engines: (EngineWrapper | undefined)[] = [undefined, undefined];
let stockfishResolve : (e: any) => void;
const StockfishConstructor = new Promise<Function>((resolve) => {
  stockfishResolve = resolve;
});

async function newStockfishEngine() {
  const create = await StockfishConstructor;
  console.log('creating new stockfish engine', create)
  return new EngineWrapper(await create(), () => { })
}

async function chatCompletionsQuery(model: ChatModel, game: ChessInstance, system: string, prompt: string) {
  const possibleMoves = game.moves();
  if (game.game_over() || game.in_draw() || possibleMoves.length === 0) return null;

  const response = await openai.chat.completions.create({
    model: model,
    messages: [
      {
        "role": "system",
        "content": system
      },
      {
        "role": "user",
        "content": prompt + game.pgn() || '1. '
      }
    ],
    temperature: 1,
    max_tokens: 10,
    top_p: 1,
    frequency_penalty: 0,
    presence_penalty: 0,
  });

  const response_content = response.choices[0].message.content;
  if (!response_content) throw new Error('No choice found');
  let choice = response_content.trim().split(' ').filter(item => !item.includes('.'))[0]
  const move = possibleMoves.find((move) => move === choice);
  console.log(`Moves: ${possibleMoves}, choice: ${choice}, raw: ${response_content}, found_move: ${move}`)
  if (!move) return null
  return move;
}

async function completionsQuery(model: CompletionModel, game: ChessInstance, prompt: string) {
  const possibleMoves = game.moves();
  if (game.game_over() || game.in_draw() || possibleMoves.length === 0) return null;

  console.log(`PGN: ${game.pgn()}, length: ${game.pgn().length}`)

  const completion = await openai.completions.create({
    prompt: prompt + game.pgn() || '1. ',
    model: model,
    temperature: 1,
    max_tokens: 10,
    top_p: 1,
    frequency_penalty: 0,
    presence_penalty: 0,
  });
  const response_content = completion.choices[0].text
  let choice = response_content.trim().split(' ').filter(item => !item.includes('.'))[0]
  const move = possibleMoves.find((move) => move === choice);
  console.log(`Moves: ${possibleMoves}, choice: ${choice}, raw: ${response_content}, found_move: ${move}`)
  if (!move) return null
  return move;
}

export default function PlayEngine() {
  const [game, setGame] = useState(new Chess());
  const [model, setModel] = useState<Model>(DEFAULT_MODEL);
  const [lastMessage, setLastMessage] = useState("");
  const [PGNInput, setPGNInput] = useState("");
  const [systemPrompt, setSystemPrompt] = useState(DEFAULT_SYSTEM_PROMPT);
  const [userPrompt, setUserPrompt] = useState(DEFAULT_USER_PROMPT);
  const [retryCount, setRetryCount] = useState(0);

  useEffect(() => {
    let key = process.env.NEXT_PUBLIC_OPENAI_API_KEY;
    if (!key) {
      key = prompt('Please enter your OpenAI API key (local only):') || '';
      console.log('key', key);
    }
    openai = new OpenAI({
      apiKey: key,
      dangerouslyAllowBrowser: true,
    })
  }, []);

  // AutoPlay logic
  const [isAutoPlay, setIsAutoPlay] = useState(false);
  const [model2, setModel2] = useState<Model>(DEFAULT_MODEL_2);
  const isAutoPlayRef = useRef(isAutoPlay);

  useEffect(() => {
    let timeoutId: NodeJS.Timeout;
    if (isAutoPlay) {
      timeoutId = setTimeout(autoPlay, 200);
    }
    return () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    };
  }, [isAutoPlay]);

  useEffect(() => {
    isAutoPlayRef.current = isAutoPlay;
  }, [isAutoPlay]);

  async function autoPlay() {
    if (!isAutoPlayRef.current) return;

    if (game.game_over()) {
      setIsAutoPlay(false);
      setLastMessage('Game is over. Reset board to play again.')
      return;
    }

    // allow more retries for first move because it's more likely to be invalid
    const retryLimit = game.history().length > 0 ? 3 : 10;

    // if it's white's go, it's black's turn to play
    const playerToPlay = game.turn() === 'w' ? 0 : 1;
    const currentModel = playerToPlay == 0 ? model : model2;

    if (currentModel.startsWith("stockfish")) {
      const move = await makeStockfishMove(currentModel as StockfishModel, playerToPlay);
      setRetryCount(0);
      setLastMessage(`Stockfish model suggests move: ${move.to}.`);
      //movePiece(move); // already done in makeStockfishMove
    }
    else {
      const move = useChatCompletions[currentModel as LLModel]
          ? await chatCompletionsQuery(currentModel as ChatModel, game, systemPrompt, userPrompt)
          : await completionsQuery(currentModel as CompletionModel, game, userPrompt);

      if (!move) {
        setRetryCount(prevCount => {
          const updatedCount = prevCount + 1;
          console.log("invalid move, retrying...", updatedCount)
          if (updatedCount < retryLimit) {
            setTimeout(autoPlay, 200);
            return updatedCount;
          } else {
            setIsAutoPlay(false);
            setLastMessage(`No/invalid move found by model (${modelOptions[currentModel]}) after ${updatedCount} retries. AutoPlay stopped.`);
            return 0;
          }
        });
        return;
      }
      setRetryCount(0);
      setLastMessage(`Model suggests move: ${move}.`);
      movePiece(move);
    }
    setTimeout(autoPlay, 200);
  }

  function resetBoard() {
    setGame(new Chess());
    setLastMessage("");
  }

  function setGameStateFromPGN(pgn: string) {
    const gameCopy = { ...game };
    const isLoaded = gameCopy.load_pgn(pgn);
    if (!isLoaded) {
      console.error('Invalid PGN provided');
      setPGNInput('Invalid PGN provided');
      return;
    }
    setPGNInput('');
    setGame({ ...gameCopy });
  }

  function movePiece(move: ShortMove | string) {
    const gameCopy = { ...game };
    const result = gameCopy.move(move);
    setGame(gameCopy);
    return result;
  }

  async function makeChatCompletionsMove() {
    const move = await chatCompletionsQuery(model as ChatModel, game, systemPrompt, userPrompt);
    if (!move) return setLastMessage('No/invalid move found by model. Try again by clicking button above.');
    setLastMessage(`Model suggests move: ${move}.`);
    movePiece(move);
  }

  async function makeCompletionsMove() {
    const move = await completionsQuery(model as CompletionModel, game, userPrompt);
    if (!move) return setLastMessage('No/invalid move found by model. Try again by clicking button above.');
    setLastMessage(`Model suggests move: ${move}.`);
    movePiece(move);
  }

  async function makeStockfishMove(currentModel: StockfishModel = model as StockfishModel, playerToPlay: 0 | 1 = 0) {
    if (!currentModel.startsWith("stockfish")) {
      throw new Error('Invalid stockfish model: ' + currentModel)
    }
    const engine = engines[playerToPlay] = engines[playerToPlay] ?? await newStockfishEngine();

    const stockfishLevel = parseInt(currentModel.split('-')[1]);
    // @ts-ignore (EngineWrapper.options isn't well typed)
    const engineLevel = engine.options['Skill Level'] as int;
    if (stockfishLevel !== engineLevel) {
      console.log(`Setting stockfish skill level to ${stockfishLevel} for engine ${playerToPlay}. (Was ${engineLevel})`)
      await engine.initialize({ Threads: STOCKFISH_THREADS, 'Skill Level': stockfishLevel });
      await engine.initializeGame();
    }
    const fen = game.fen();
    engine.send(`position fen ${fen}`);
    engine.send("isready");
    await engine.receiveUntil((line: string) => line === "readyok");
    engine.send("go movetime 1000");
    const lines = await engine.receiveUntil((line: string) =>
      line.startsWith("bestmove")
    );
    const last_line = lines[lines.length - 1];
    const bestmove = last_line.split(" ")[1];
    console.log("bestmove:", bestmove);

    const move = {
      from: bestmove.substr(0, 2),
      to: bestmove.substr(2, 2),
      promotion: bestmove.length == 5 ? bestmove.substr(4, 1) : undefined
    } as ShortMove;
    movePiece(move);
    return move;
  }

  async function makeNextMove() {
    if (game.game_over()) {
      return setLastMessage('Game is over. Reset board to play again.')
    }
    if (model.startsWith("stockfish")) {
      return await makeStockfishMove() 
    }
    return useChatCompletions[model as LLModel] ? await makeChatCompletionsMove() : await makeCompletionsMove()
  }


  function onDrop(sourceSquare: Square, targetSquare: Square, piece: Piece): boolean {
    const move = movePiece({ from: sourceSquare, to: targetSquare, promotion: "q" });
    if (move === null) return false;
    setIsAutoPlay(false);
    makeNextMove();
    return true;
  }

  function describeGameState() {
    if (game.game_over()) {
      if (game.in_stalemate()) {
        return 'Stalemate!';
      }
      else if (game.in_draw()) {
        if (game.in_threefold_repetition()) {
          return 'Draw! Threefold repetition.';
        } else if (game.insufficient_material()) {
          return 'Draw! Insufficient material.';
        } else {
          return 'Draw! 50 move rule.';
        }
      }
      else {
        return `Checkmate! ${game.turn() === 'w' ? 'Black' : 'White'} wins!`;
      }
    }
    const turn = game.turn() === 'w' ? 'White' : 'Black';
    const status = game.in_check() ? 'Check. ' : '';
    return `${status}${turn} to move.`;

  }

  return (
    <main className="bg-gray-100 min-h-screen p-10">
      <Script src="./lib/stockfish/stockfish.js" onLoad={async () =>
        // @ts-ignore Stockfish is imported via <Script>
        stockfishResolve(Stockfish)}></Script>
      <div className="mx-auto flex tt:flex-row flex-col space-x-5 justify-between">
        <div className="controls mb-5 flex flex-col space-y-4">
          <h1 className="text-4xl font-bold">ChessGPT<small>+ Stockfish</small></h1>
          <div className="flex items-center space-x-2">
            <label className="text-xl font-semibold">Select Model:</label>
            <select
              value={model}
              onChange={(e) => setModel(e.target.value as Model)}
              className="border border-gray-300 p-2 rounded-md shadow-sm"
            >
              {Object.entries(modelOptions).map(([model, name]) => <option key={model} value={model}>{name}</option>)}
            </select>
          </div>
          <button
            onClick={resetBoard}
            className="bg-blue-500 text-white py-2 px-4 rounded-md hover:bg-blue-600 active:bg-blue-700 focus:outline-none"
          >
            Reset Board
          </button>
          <button
            onClick={makeNextMove}
            className="bg-blue-500 text-white py-2 px-4 rounded-md hover:bg-blue-600 active:bg-blue-700 focus:outline-none"
          >
            Force Model to Make Next Move
          </button>
          <div className="flex flex-col space-y-1">
            <label className="text-xl font-semibold">Set PGN:</label>
            <div className="flex items-center space-x-2">
              <textarea
                rows={2}
                placeholder="Paste PGN here"
                onChange={(e) => setPGNInput(e.target.value)}
                value={PGNInput}
                className="border border-gray-300 p-2 w-full rounded-md shadow-sm"
              />
              <button
                onClick={() => setGameStateFromPGN(PGNInput)}
                className="bg-blue-500 text-white py-2 px-4 rounded-md hover:bg-blue-600 active:bg-blue-700 focus:outline-none"
              >
                Set State from PGN
              </button>
            </div>
          </div>
          <div className="flex flex-col space-y-1">
            <label className="text-xl font-semibold">Set System Prompt:</label>
            <textarea
              rows={(useChatCompletions[model as LLModel] ?? false) ? 5 : 1}
              placeholder="Enter system prompt here"
              onChange={(e) => setSystemPrompt(e.target.value)}
              value={(useChatCompletions[model as LLModel] ?? false) ? DEFAULT_SYSTEM_PROMPT : 'No system prompt for completion models.'}
              className="border border-gray-300 p-2 w-full rounded-md shadow-sm"
              disabled={!(useChatCompletions[model as LLModel] ?? false)}
            />
          </div>
          <div className="flex flex-col space-y-1">
            <label className="text-xl font-semibold">Set User Prompt:</label>
            <textarea
              rows={5}
              placeholder="Enter user prompt here"
              onChange={(e) => setUserPrompt(e.target.value)}
              value={userPrompt}
              className="border border-gray-300 p-2 w-full rounded-md shadow-sm"
            />
          </div>
          <div className="flex flex-col space-y-1">
            <div className="flex justify-between">
              <label className="text-xl font-semibold">Current PGN:</label>
              <button
                id="copyButton"
                onClick={() => {
                  navigator.clipboard.writeText(game.pgn() || '1. ');
                  let copyButton = document.getElementById("copyButton");
                  if (copyButton) {
                    copyButton.innerText = "Copied!";
                    setTimeout(() => {
                      if (copyButton) copyButton.innerText = "Copy PGN";
                    }, 2000);
                  }
                }}
                className="text-slate-500 py-1 px-2 rounded-md hover:text-slate-700 active:text-slate-800 focus:outline-none"
              >
                Copy PGN
              </button>
            </div>
            <div className="flex items-center space-x-2 max-w-[380px]">
              <p className="border border-gray-300 p-2 w-full rounded-md shadow-sm">
                {game.pgn() || '1. '}
              </p>
            </div>
          </div>

        </div>
        <div className="basis-[500px] max-w-[600px] max-h-[600px] m-auto rounded-md">
          <h2 className="text-xl font-semibold text-center mb-4">{describeGameState()}</h2>
          <Chessboard position={game.fen()} onPieceDrop={onDrop} />
        </div>
        <div className="mb-5 p-4 rounded-md shadow-sm border border-gray-300 mt-4">
          <h2 className="text-xl font-semibold">Auto Play</h2>
          <div className="flex flex-col mt-1 space-y-1">
            <label className="text-lg font-normal">Select Model 2 (black):</label>
            <select
              value={model2}
              onChange={(e) => setModel2(e.target.value as Model)}
              className="border border-gray-300 p-2 rounded-md shadow-sm"
            >
              {Object.entries(modelOptions).map(([model, name]) => <option key={model} value={model}>{name}</option>)}
            </select>
          </div>
          <button
            onClick={() => setIsAutoPlay(!isAutoPlay)}
            className="bg-blue-500 text-white py-2 px-4 rounded-md hover:bg-blue-600 active:bg-blue-700 focus:outline-none mt-3"
          >
            {isAutoPlay ? 'Stop Auto Play' : 'Start Auto Play'}
          </button>
          <hr className="my-4" />
          <div className="mb-5 bg-white p-4 rounded-md shadow-sm mt-2">
            <label className="text-md font-semibold">Last message:</label>
            <p className="mt-2 w-48">{lastMessage || (retryCount ? '' : '...')}</p>
            {retryCount ? (<p>{`Retrying...${retryCount}`}</p>): undefined}
          </div>
        </div>
      </div>
      <p className="italic text-gray-500"><a className="underline" href="https://gptchess.vercel.app/">ChessGPT</a> by <a className="underline" href="https://twitter.com/willdepue">will depue</a>. Want to get paid to do research on cutting edge large language models? <a className="underline" href="https://openai.com/careers/">Join OpenAI!</a></p>
      <p className="italic text-gray-500">Stockfish (WASM) added by <a className="underline" href="https://twitter.com/paul_cal">paul_cal</a>, using <a className="underline" href="https://github.com/hi-ogawa/Stockfish">github.com/hi-ogawa/Stockfish</a>.</p>
      <p className="italic text-gray-500">Full code: <a className="underline" href="https://github.com/paulcalcraft/chessgpt-stockfish">github.com/paulcalcraft/chessgpt-stockfish</a></p>
    </main>
  );
}
