// from https://github.com/hi-ogawa/stockfish-nnue-wasm-demo
class Queue {
    constructor() {
        this.getter = null;
        this.list = [];
    }
    async get() {
        if (this.list.length > 0) {
            return this.list.shift();
        }
        return await new Promise((resolve) => (this.getter = resolve));
    }
    put(x) {
        if (this.getter) {
            this.getter(x);
            this.getter = null;
            return;
        }
        this.list.push(x);
    }
}

export class EngineWrapper {
  constructor(engine, log = console.log) {
    this.engine = engine;
    this.queue = new Queue();
    this.engine.addMessageListener((line) => this.queue.put(line));
    this.log = log;
  }

  send(command) {
    this.log(">>(engine)", command);
    this.engine.postMessage(command);
  }

  async receive() {
    const line = await this.queue.get();
    this.log("<<(engine)", line);
    return line;
  }

  async receiveUntil(predicate) {
    const lines = [];
    while (true) {
      const line = await this.receive();
      lines.push(line);
      if (predicate(line)) {
        break;
      }
    }
    return lines;
  }

  async initialize(options = {}) {
    this.send("uci");
    await this.receiveUntil((line) => line === "uciok");
    for (const name in options) {
      this.send(`setoption name ${name} value ${options[name]}`);
    }
    this.send("isready");
    await this.receiveUntil((line) => line === "readyok");
  }

  async initializeGame() {
    this.send("ucinewgame");
    this.send("isready");
    await this.receiveUntil((line) => line === "readyok");
  }
}