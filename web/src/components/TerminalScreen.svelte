<script lang="ts">
  import Icon from "./Icon.svelte";

  interface Props {
    screen: string;
    active: boolean;
  }
  let { screen, active }: Props = $props();
</script>

<div class="screen-wrap">
  <div class="term">
    <div class="term-head">
      <Icon name="terminal" size={13} />
      <span class="term-title">live output</span>
      {#if active}<span class="live-dot" aria-hidden="true"></span>{/if}
    </div>
    <div class="term-body">
      {#if screen}
        <pre class="font-mono-term">{screen}</pre>
      {:else}
        <div class="empty">
          <Icon name="terminal" size={30} />
          <p>{active ? "waiting for screen…" : "session not running"}</p>
        </div>
      {/if}
    </div>
  </div>
</div>

<style>
  .screen-wrap {
    flex: 1;
    min-height: 0;
    display: flex;
    padding: 16px 20px;
  }
  .term {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    background: var(--term-bg);
    border: 1px solid var(--border-soft);
    border-radius: var(--radius-box);
    overflow: hidden;
  }
  .term-head {
    flex: none;
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 8px 14px;
    border-bottom: 1px solid var(--border-soft);
    background: rgba(255, 255, 255, 0.02);
    color: var(--faint);
  }
  .term-title {
    font-size: 10.5px;
    text-transform: uppercase;
    letter-spacing: 1px;
    font-weight: 700;
  }
  .live-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--color-primary);
    box-shadow: 0 0 0 0 rgba(34, 197, 94, 0.55);
    animation: live-pulse 1.6s ease-out infinite;
  }
  .term-body {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 14px 16px;
  }
  pre {
    margin: 0;
    font-size: 12.5px;
    line-height: 1.4;
    color: #cbd5e1;
    white-space: pre;
    tab-size: 2;
  }
  .empty {
    color: var(--faint);
    padding: 48px 24px;
    text-align: center;
  }
  .empty p {
    margin: 0;
    font-size: 12.5px;
  }
  .empty :global(svg) {
    margin: 0 auto 12px;
    opacity: 0.4;
  }
  @keyframes live-pulse {
    0% {
      box-shadow: 0 0 0 0 rgba(34, 197, 94, 0.5);
      opacity: 1;
    }
    70% {
      box-shadow: 0 0 0 6px rgba(34, 197, 94, 0);
      opacity: 0.7;
    }
    100% {
      box-shadow: 0 0 0 0 rgba(34, 197, 94, 0);
      opacity: 1;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .live-dot {
      animation: none;
    }
  }
  @media (max-width: 640px) {
    .screen-wrap {
      padding: 12px 14px;
      /* page scrolls as one column on mobile; give the terminal a fixed,
         legible height instead of trying to flex-fill a viewport-locked pane */
      flex: none;
    }
    .term {
      flex: none;
      height: 280px;
    }
  }
</style>
