/**
 * Terminal-Manager: hält pro Agent eine persistente xterm-Instanz (+ DOM-Element),
 * sodass Live-Output erhalten bleibt, auch wenn der Nutzer zwischen Agenten umschaltet.
 * Der Inspector hängt das DOM-Element des selektierten Agenten in seinen Container.
 */
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

interface Entry {
  term: Terminal;
  fit: FitAddon;
  el: HTMLDivElement;
  opened: boolean;
}

const terminals = new Map<string, Entry>();

const THEME = {
  background: "#1c1c1e",
  foreground: "#e4e4e7",
  cursor: "#e4e4e7",
  black: "#3a3a3c",
  brightBlack: "#636366",
  red: "#ff6b6b",
  green: "#30d158",
  yellow: "#ffd60a",
  blue: "#0a84ff",
  magenta: "#bf5af2",
  cyan: "#64d2ff",
  white: "#e4e4e7",
};

function getEntry(id: string): Entry {
  let e = terminals.get(id);
  if (!e) {
    const el = document.createElement("div");
    el.className = "term-host";
    const term = new Terminal({
      convertEol: true,
      fontSize: 12,
      lineHeight: 1.3,
      fontFamily: 'ui-monospace, "SF Mono", Menlo, Monaco, monospace',
      cursorBlink: false,
      scrollback: 8000,
      theme: THEME,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    e = { term, fit, el, opened: false };
    terminals.set(id, e);
  }
  return e;
}

export function writeLine(id: string, text: string): void {
  getEntry(id).term.writeln(text);
}

export function mountTerminal(id: string, container: HTMLElement): void {
  const e = getEntry(id);
  if (e.el.parentElement !== container) {
    container.replaceChildren(e.el);
  }
  if (!e.opened) {
    e.term.open(e.el);
    e.opened = true;
  }
  // nach dem Anhängen passt die Größe zum Container
  requestAnimationFrame(() => {
    try {
      e.fit.fit();
    } catch {
      /* Container evtl. (noch) 0px */
    }
  });
}

export function fitTerminal(id: string): void {
  const e = terminals.get(id);
  if (!e || !e.opened) return;
  try {
    e.fit.fit();
  } catch {
    /* noop */
  }
}

export function disposeTerminal(id: string): void {
  const e = terminals.get(id);
  e?.term.dispose();
  terminals.delete(id);
}
