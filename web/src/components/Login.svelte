<script lang="ts">
  import { auth } from "../lib/auth.svelte";
  import Icon from "./Icon.svelte";

  let token = $state("");
  let busy = $state(false);

  async function connect(e: Event) {
    e.preventDefault();
    if (!token.trim() || busy) return;
    busy = true;
    await auth.submit(token);
    busy = false;
  }

  function retry() {
    auth.status = "checking";
    auth.error = null;
    void auth.init();
  }
</script>

<div class="gate">
  <div class="card">
    <div class="brand">
      <span class="mark"><Icon name="spark" size={20} /></span>
      <div>
        <h1>AGI Dispatch</h1>
        <div class="sub">remote access to your orchestrator</div>
      </div>
    </div>

    {#if auth.status === "checking"}
      <div class="state">
        <span class="spinner"></span>
        <span>connecting…</span>
      </div>
    {:else if auth.status === "disabledRemote"}
      <div class="msg warn">
        <Icon name="alert" size={15} />
        <div>
          <b>Remote access is disabled.</b>
          <p>
            On the machine running AGI, set a <code>dispatch.token</code> in
            <code>config.json</code> (or the <code>AGI_DISPATCH_TOKEN</code> env var) and restart,
            then enter that token here.
          </p>
        </div>
      </div>
      <button class="btn btn-sm" onclick={retry}>Retry</button>
    {:else if auth.status === "error"}
      <div class="msg">
        <Icon name="alert" size={15} />
        <span>{auth.error ?? "Something went wrong."}</span>
      </div>
      <button class="btn btn-primary btn-sm" onclick={retry}>Retry</button>
    {:else}
      <!-- needsToken -->
      <form onsubmit={connect}>
        <label for="tok">Access token</label>
        <input
          id="tok"
          type="password"
          autocomplete="current-password"
          inputmode="text"
          placeholder="paste your dispatch token"
          bind:value={token}
          disabled={busy}
        />
        {#if auth.error}
          <div class="err" role="alert">{auth.error}</div>
        {/if}
        <button class="btn btn-primary connect" type="submit" disabled={busy || !token.trim()}>
          {#if busy}<span class="spinner sm"></span> checking…{:else}Connect{/if}
        </button>
      </form>
      <p class="hint">
        The token is set on the server. It's stored only on this device. Prefer a TLS tunnel
        (Tailscale / Cloudflare Tunnel) over plain HTTP.
      </p>
    {/if}
  </div>
</div>

<style>
  .gate {
    min-height: 100dvh;
    display: grid;
    place-items: center;
    padding: 20px;
    color: var(--color-base-content);
  }
  .card {
    width: 100%;
    max-width: 380px;
    background: var(--color-base-100);
    border: 1px solid var(--border-soft);
    border-radius: 16px;
    padding: 24px 22px;
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.4);
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 22px;
  }
  .mark {
    width: 40px;
    height: 40px;
    border-radius: 11px;
    background: linear-gradient(135deg, var(--color-primary), #16a34a);
    display: grid;
    place-items: center;
    color: var(--color-primary-content);
    flex: none;
    box-shadow: 0 0 0 1px rgba(34, 197, 94, 0.4);
  }
  h1 {
    font-size: 18px;
    margin: 0;
    font-weight: 700;
  }
  .sub {
    font-size: 12px;
    color: var(--faint);
  }

  label {
    display: block;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.6px;
    font-weight: 600;
    color: var(--color-neutral-content);
    margin-bottom: 7px;
  }
  input {
    width: 100%;
    font: inherit;
    font-size: 16px; /* ≥16px so mobile Safari doesn't auto-zoom */
    color: var(--color-base-content);
    background: var(--color-base-200);
    border: 1px solid var(--border-strong);
    border-radius: 10px;
    padding: 12px 13px;
    min-height: 46px;
  }
  input:focus {
    outline: none;
    border-color: var(--color-primary);
  }
  .connect {
    width: 100%;
    margin-top: 14px;
    min-height: 46px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
  }
  .err {
    color: var(--color-error);
    font-size: 12.5px;
    margin-top: 9px;
  }
  .hint {
    margin: 16px 0 0;
    font-size: 11.5px;
    line-height: 1.5;
    color: var(--faint);
  }
  .state {
    display: flex;
    align-items: center;
    gap: 10px;
    color: var(--color-neutral-content);
    font-size: 14px;
    padding: 8px 0;
  }
  .msg {
    display: flex;
    gap: 9px;
    align-items: flex-start;
    color: var(--color-neutral-content);
    font-size: 13px;
    line-height: 1.5;
    margin-bottom: 14px;
  }
  .msg.warn {
    color: var(--color-warning);
  }
  .msg p {
    margin: 6px 0 0;
    color: var(--color-neutral-content);
  }
  .msg code {
    font-family: ui-monospace, monospace;
    font-size: 11.5px;
    background: var(--color-base-200);
    padding: 1px 5px;
    border-radius: 5px;
  }
  .spinner {
    width: 18px;
    height: 18px;
    border-radius: 50%;
    border: 2px solid var(--border-strong);
    border-top-color: var(--color-primary);
    animation: spin 0.7s linear infinite;
    flex: none;
  }
  .spinner.sm {
    width: 14px;
    height: 14px;
    border-width: 2px;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .spinner {
      animation-duration: 1.6s;
    }
  }
</style>
