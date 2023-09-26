**Updated** 26/09/2023

Set temperature to zero after recommendation from [Joel Eriksson](https://twitter.com/paul_cal/status/1706724232720523455).

Added experimental mode that runs on autopilot if run locally with NODE_ENV=development (npm run dev). Find experimentalPlans in page.tsx to reconfigure.

To avoid re-entering API key, create a `.env.local` file with:
>NEXT_PUBLIC_OPENAI_API_KEY=####################
## ChessGPT + Stockfish

Forked from will depue's [0hq/chessgpt](https://github.com/0hq/chessgpt), added Stockfish (in browser, using WASM, from [hi-ogawa/Stockfish](https://github.com/hi-ogawa/Stockfish)).

I similarly apologise for very hacked together code, as below.

Try it:

[chessgpt-stockfish.vercel.app](https://chessgpt-stockfish.vercel.app/) (with stockfish)

From [0hq/chessgpt](https://github.com/0hq/chessgpt):
>### ChessGPT
>
>I apologize for very hacked together code, but this should give a good representation of GPT 3.5 and GPT 4's playing abilities.  
>
>[gptchess.com](https://gptchess.vercel.app/) (original)
>
