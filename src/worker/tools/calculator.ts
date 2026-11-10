/**
 * A small, safe math expression evaluator (recursive descent, no eval).
 *
 * Supports: + - * / % ^ (power, right-associative), unary +/-, postfix ! (factorial),
 * parentheses, scientific notation (1.5e3), constants (pi, e, tau) and functions:
 * sqrt cbrt abs sign exp ln log log10 log2 sin cos tan asin acos atan atan2 sinh cosh tanh
 * floor ceil round(x[, digits]) trunc min max pow hypot.
 * Trigonometry uses radians; deg(x) and rad(x) convert.
 */

const MAX_LENGTH = 500;
const MAX_DEPTH = 64;

const CONSTANTS: Record<string, number> = { pi: Math.PI, e: Math.E, tau: 2 * Math.PI };

type Fn = { min: number; max: number; fn: (...args: number[]) => number };
const FUNCTIONS: Record<string, Fn> = {
  sqrt: { min: 1, max: 1, fn: Math.sqrt },
  cbrt: { min: 1, max: 1, fn: Math.cbrt },
  abs: { min: 1, max: 1, fn: Math.abs },
  sign: { min: 1, max: 1, fn: Math.sign },
  exp: { min: 1, max: 1, fn: Math.exp },
  ln: { min: 1, max: 1, fn: Math.log },
  log: { min: 1, max: 2, fn: (x, base) => (base === undefined ? Math.log10(x) : Math.log(x) / Math.log(base)) },
  log10: { min: 1, max: 1, fn: Math.log10 },
  log2: { min: 1, max: 1, fn: Math.log2 },
  sin: { min: 1, max: 1, fn: Math.sin },
  cos: { min: 1, max: 1, fn: Math.cos },
  tan: { min: 1, max: 1, fn: Math.tan },
  asin: { min: 1, max: 1, fn: Math.asin },
  acos: { min: 1, max: 1, fn: Math.acos },
  atan: { min: 1, max: 1, fn: Math.atan },
  atan2: { min: 2, max: 2, fn: Math.atan2 },
  sinh: { min: 1, max: 1, fn: Math.sinh },
  cosh: { min: 1, max: 1, fn: Math.cosh },
  tanh: { min: 1, max: 1, fn: Math.tanh },
  deg: { min: 1, max: 1, fn: (x) => (x * 180) / Math.PI },
  rad: { min: 1, max: 1, fn: (x) => (x * Math.PI) / 180 },
  floor: { min: 1, max: 1, fn: Math.floor },
  ceil: { min: 1, max: 1, fn: Math.ceil },
  trunc: { min: 1, max: 1, fn: Math.trunc },
  round: {
    min: 1,
    max: 2,
    fn: (x, digits) => {
      const d = Math.max(0, Math.min(15, Math.trunc(digits ?? 0)));
      const f = 10 ** d;
      return Math.round(x * f) / f;
    },
  },
  min: { min: 1, max: 100, fn: Math.min },
  max: { min: 1, max: 100, fn: Math.max },
  pow: { min: 2, max: 2, fn: Math.pow },
  hypot: { min: 1, max: 100, fn: Math.hypot },
};

export class CalcError extends Error {}

type Token = { type: "num"; value: number } | { type: "id"; value: string } | { type: "op"; value: string };

function tokenize(input: string): Token[] {
  const src = input.replace(/[×✕]/g, "*").replace(/÷/g, "/").replace(/−/g, "-").replace(/\*\*/g, "^");
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    const num = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(src.slice(i));
    if (num) {
      tokens.push({ type: "num", value: Number(num[0]) });
      i += num[0].length;
      continue;
    }
    const id = /^[a-z_][a-z0-9_]*/i.exec(src.slice(i));
    if (id) {
      tokens.push({ type: "id", value: id[0].toLowerCase() });
      i += id[0].length;
      continue;
    }
    if ("+-*/%^(),!".includes(ch)) {
      tokens.push({ type: "op", value: ch });
      i++;
      continue;
    }
    throw new CalcError(`Unexpected character "${ch}"`);
  }
  return tokens;
}

function factorial(n: number): number {
  if (!Number.isInteger(n) || n < 0) throw new CalcError("Factorial is only defined for non-negative integers");
  if (n > 170) return Infinity;
  let r = 1;
  for (let k = 2; k <= n; k++) r *= k;
  return r;
}

class Parser {
  private pos = 0;
  private depth = 0;
  constructor(private readonly tokens: Token[]) {}

  parse(): number {
    const value = this.expression();
    if (this.pos < this.tokens.length) throw new CalcError("Unexpected input after the end of the expression");
    return value;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private isOp(value: string): boolean {
    const t = this.peek();
    return t?.type === "op" && t.value === value;
  }

  private expect(value: string): void {
    if (!this.isOp(value)) throw new CalcError(`Expected "${value}"`);
    this.pos++;
  }

  private enter(): void {
    if (++this.depth > MAX_DEPTH) throw new CalcError("Expression is nested too deeply");
  }

  private expression(): number {
    this.enter();
    let value = this.term();
    while (this.isOp("+") || this.isOp("-")) {
      const op = (this.tokens[this.pos++] as { value: string }).value;
      const right = this.term();
      value = op === "+" ? value + right : value - right;
    }
    this.depth--;
    return value;
  }

  private term(): number {
    let value = this.unary();
    while (this.isOp("*") || this.isOp("/") || this.isOp("%")) {
      const op = (this.tokens[this.pos++] as { value: string }).value;
      const right = this.unary();
      if ((op === "/" || op === "%") && right === 0) throw new CalcError("Division by zero");
      value = op === "*" ? value * right : op === "/" ? value / right : value % right;
    }
    return value;
  }

  /** Unary minus binds looser than ^, so -2^2 = -4. */
  private unary(): number {
    if (this.isOp("-")) {
      this.pos++;
      return -this.unary();
    }
    if (this.isOp("+")) {
      this.pos++;
      return this.unary();
    }
    return this.power();
  }

  private power(): number {
    const base = this.postfix();
    if (this.isOp("^")) {
      this.pos++;
      this.enter();
      const exponent = this.unary(); // right-associative, allows 2^-1
      this.depth--;
      return base ** exponent;
    }
    return base;
  }

  private postfix(): number {
    let value = this.primary();
    while (this.isOp("!")) {
      this.pos++;
      value = factorial(value);
    }
    return value;
  }

  private primary(): number {
    const token = this.peek();
    if (!token) throw new CalcError("Unexpected end of expression");
    if (token.type === "num") {
      this.pos++;
      return token.value;
    }
    if (token.type === "op" && token.value === "(") {
      this.pos++;
      const value = this.expression();
      this.expect(")");
      return value;
    }
    if (token.type === "id") {
      this.pos++;
      const name = token.value;
      if (this.isOp("(")) {
        // Own-property lookup only: names like "constructor" must not reach Object.prototype.
        const fn = Object.hasOwn(FUNCTIONS, name) ? FUNCTIONS[name] : undefined;
        if (!fn) throw new CalcError(`Unknown function "${name}"`);
        this.pos++;
        const args: number[] = [];
        if (!this.isOp(")")) {
          args.push(this.expression());
          while (this.isOp(",")) {
            this.pos++;
            args.push(this.expression());
          }
        }
        this.expect(")");
        if (args.length < fn.min || args.length > fn.max) {
          throw new CalcError(`${name}() takes ${fn.min === fn.max ? fn.min : `${fn.min}-${fn.max}`} argument(s)`);
        }
        return fn.fn(...args);
      }
      const constant = Object.hasOwn(CONSTANTS, name) ? CONSTANTS[name] : undefined;
      if (constant === undefined) throw new CalcError(`Unknown name "${name}"`);
      return constant;
    }
    throw new CalcError(`Unexpected "${token.value}"`);
  }
}

/** Evaluate an expression; throws CalcError with a readable message on bad input. */
export function evaluate(expression: string): number {
  if (expression.length > MAX_LENGTH) throw new CalcError(`Expression is longer than ${MAX_LENGTH} characters`);
  const tokens = tokenize(expression);
  if (tokens.length === 0) throw new CalcError("Empty expression");
  const value = new Parser(tokens).parse();
  if (Number.isNaN(value)) throw new CalcError("The result is not a number (e.g. square root of a negative)");
  if (!Number.isFinite(value)) throw new CalcError("The result is too large (infinite)");
  // Trim floating-point noise such as 0.1 + 0.2 = 0.30000000000000004.
  return Number(value.toPrecision(15));
}
