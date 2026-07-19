import readline from "node:readline";
import { InstanceColor } from "../core/types.js";

const noColor = !!process.env.NO_COLOR || !process.stdout.isTTY;

const CODES: Record<string, string> = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  gray: "\x1b[90m",
  blue: "\x1b[34m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  orange: "\x1b[38;5;208m",
  red: "\x1b[31m",
  purple: "\x1b[35m",
  pink: "\x1b[38;5;213m",
  teal: "\x1b[36m",
  cyan: "\x1b[36m",
};

export function c(color: string, text: string): string {
  if (noColor || !CODES[color]) return text;
  return `${CODES[color]}${text}${CODES.reset}`;
}

export function bold(text: string): string {
  return c("bold", text);
}
export function dim(text: string): string {
  return c("dim", text);
}

/** A colored ● chip for an instance color. */
export function chip(color: InstanceColor): string {
  return c(color, "●");
}

export function statusDot(status: string): string {
  if (status === "connected" || status === "ok") return c("green", "●");
  if (status === "error") return c("red", "●");
  return c("gray", "○");
}

export function heading(text: string): void {
  console.log("\n" + bold(text));
}

/** Render an aligned table. */
export function table(rows: string[][], opts: { head?: string[] } = {}): void {
  const all = opts.head ? [opts.head, ...rows] : rows;
  if (!all.length) return;
  const cols = Math.max(...all.map((r) => r.length));
  const widths: number[] = [];
  for (let i = 0; i < cols; i++) {
    widths[i] = Math.max(...all.map((r) => visibleLen(r[i] ?? "")));
  }
  const fmt = (r: string[], head = false) =>
    r
      .map((cell, i) => {
        const pad = " ".repeat(Math.max(0, widths[i] - visibleLen(cell ?? "")));
        const text = (cell ?? "") + pad;
        return head ? bold(text) : text;
      })
      .join("  ");
  if (opts.head) console.log(fmt(opts.head, true));
  for (const r of rows) console.log(fmt(r));
}

function visibleLen(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

export function ok(msg: string): void {
  console.log(c("green", "✓") + " " + msg);
}
export function warn(msg: string): void {
  console.log(c("yellow", "!") + " " + msg);
}
export function fail(msg: string): void {
  console.error(c("red", "✗") + " " + msg);
}

/** Prompt for a line of input; mask when `secret` is set. */
export function prompt(question: string, secret = false): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  if (secret) {
    const out = process.stdout as any;
    const origWrite = out.write.bind(out);
    (rl as any)._writeToOutput = (str: string) => {
      if (str.includes(question)) origWrite(str);
      else origWrite("*");
    };
  }
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      if (secret) process.stdout.write("\n");
      resolve(answer.trim());
    });
  });
}

export function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}
