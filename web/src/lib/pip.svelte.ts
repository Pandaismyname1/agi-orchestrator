/**
 * Always-on-top status window via the Document Picture-in-Picture API (Chrome/Edge),
 * plus desktop notifications on status transitions. Self-contained: feed it each
 * snapshot via update(); it renders the chip list into the PiP document and fires
 * notifications when a session flips to a notable state.
 */
import type { Snapshot } from "./types";
import { statusLabel } from "./format";

const PIP_CSS = `
  :root{--bg:#0b1120;--panel-2:#131d31;--border:#233048;--text:#f1f5f9;--muted:#94a3b8;
    --green:#22c55e;--blue:#60a5fa;--amber:#fbbf24;--red:#f87171;--gray:#475569;}
  *{box-sizing:border-box;} body{margin:0;background:var(--bg);color:var(--text);
    font:13px/1.4 "Inter",ui-sans-serif,system-ui,"Segoe UI",sans-serif;}
  #pipRoot{padding:8px;}
  .pip-h{font-size:11px;text-transform:uppercase;letter-spacing:1px;color:var(--muted);padding:4px 6px 8px;}
  .pchip{display:flex;align-items:center;gap:8px;padding:8px 10px;margin-bottom:6px;
    background:var(--panel-2);border:1px solid var(--border);border-radius:8px;cursor:pointer;}
  .pchip:hover{border-color:var(--amber);}
  .pdot{width:9px;height:9px;border-radius:50%;background:var(--gray);flex:none;}
  .pdot.running{background:var(--green);} .pdot.done{background:var(--blue);}
  .pdot.manual{background:var(--blue);} .pdot.stopped{background:var(--amber);}
  .pdot.error{background:var(--red);} .pdot.needs-input{background:var(--amber);}
  .pdot.rate-limited{background:var(--amber);} .pdot.queued{background:var(--blue);opacity:.6;}
  .pname{font-weight:600;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
  .pstat{font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:var(--muted);}
  .pturn{font-size:10px;color:var(--muted);}
  .pchip.needs-input{background:rgba(251,191,36,.16);border-color:var(--amber);
    animation:pp 1.05s ease-in-out infinite;}
  .pchip.needs-input .pstat{color:var(--amber);font-weight:700;}
  .pchip.error{background:rgba(248,113,113,.18);border-color:var(--red);
    animation:pp .85s ease-in-out infinite;}
  .pchip.error .pstat{color:var(--red);font-weight:700;}
  .pchip.rate-limited{border-color:var(--amber);animation:pp 1.3s ease-in-out infinite;}
  .pchip.rate-limited .pstat{color:var(--amber);}
  @keyframes pp{0%,100%{opacity:1;}50%{opacity:.5;}}
  .pempty{color:var(--muted);padding:14px;text-align:center;}`;

class Pip {
  supported = $state("documentPictureInPicture" in window);
  open = $state(false);

  #win: Window | null = null;
  #onFocus: ((id: string) => void) | null = null;
  #prevStatus: Record<string, string> = {};
  #lastSnapshot: Snapshot | null = null;

  /** Called when the user clicks a chip in the PiP window. */
  onFocus(cb: (id: string) => void): void {
    this.#onFocus = cb;
  }

  async toggle(): Promise<void> {
    if (this.#win) {
      this.#win.close();
      return;
    }
    if (!this.supported) return;
    try {
      // @ts-expect-error — Document PiP isn't in the DOM lib yet.
      this.#win = await documentPictureInPicture.requestWindow({ width: 320, height: 440 });
    } catch {
      return;
    }
    const win = this.#win!;
    const style = win.document.createElement("style");
    style.textContent = PIP_CSS;
    win.document.head.appendChild(style);
    win.document.body.innerHTML =
      `<div id="pipRoot"><div class="pip-h">AGI · live</div><div id="pipList"></div></div>`;
    this.open = true;
    if ("Notification" in window && Notification.permission === "default") {
      void Notification.requestPermission();
    }
    win.addEventListener("pagehide", () => {
      this.#win = null;
      this.open = false;
    });
    if (this.#lastSnapshot) this.#render(this.#lastSnapshot);
  }

  /** Feed each snapshot: fires transition notifications + repaints the PiP list. */
  update(snap: Snapshot): void {
    this.#lastSnapshot = snap;
    this.#notify(snap);
    if (this.#win) this.#render(snap);
  }

  #notify(snap: Snapshot): void {
    for (const s of snap.sessions) {
      const prev = this.#prevStatus[s.id];
      if (prev && prev !== s.status) {
        if (s.status === "needs-input")
          this.#fire(`${s.id} needs your decision`, s.attention?.question ?? "");
        else if (s.status === "done") this.#fire(`${s.id} finished`, "");
        else if (s.status === "error") this.#fire(`${s.id} errored`, s.error ?? "");
        else if (s.status === "rate-limited") this.#fire(`${s.id} rate-limited`, s.error ?? "");
      }
      this.#prevStatus[s.id] = s.status;
    }
  }

  #fire(title: string, body: string): void {
    if ("Notification" in window && Notification.permission === "granted") {
      try {
        new Notification(title, { body });
      } catch {
        /* ignore */
      }
    }
  }

  #render(snap: Snapshot): void {
    const win = this.#win;
    if (!win) return;
    const listEl = win.document.getElementById("pipList");
    if (!listEl) return;
    listEl.innerHTML =
      snap.sessions
        .map(
          (s) => `
        <div class="pchip ${s.status}" data-id="${esc(s.id)}">
          <span class="pdot ${s.status}"></span>
          <span class="pname">${esc(s.id)}</span>
          <span class="pstat">${esc(statusLabel(s.status))}</span>
          <span class="pturn">t${s.turns}</span>
        </div>`,
        )
        .join("") || `<div class="pempty">no sessions</div>`;
    listEl.querySelectorAll<HTMLElement>(".pchip").forEach((el) => {
      el.onclick = () => {
        const id = el.dataset.id;
        if (id) this.#onFocus?.(id);
        window.focus();
      };
    });
  }
}

function esc(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] ?? c);
}

export const pip = new Pip();
