<script lang="ts">
  import type { SessionStatus } from "../lib/types";
  import { statusLabel } from "../lib/format";

  interface Props {
    status: SessionStatus;
  }
  let { status }: Props = $props();
</script>

<span class="sbadge {status}" class:pulse={status === "needs-input"}>{statusLabel(status)}</span>

<style>
  .sbadge {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.6px;
    font-weight: 600;
    padding: 2px 8px;
    border-radius: 20px;
    border: 1px solid var(--border-soft);
    color: var(--faint);
    white-space: nowrap;
  }
  .running {
    color: var(--st-running);
    border-color: rgba(34, 197, 94, 0.5);
    background: rgba(34, 197, 94, 0.08);
  }
  .manual {
    color: var(--st-manual);
    border-color: rgba(96, 165, 250, 0.5);
    background: rgba(96, 165, 250, 0.08);
  }
  .queued {
    color: var(--st-queued);
    border-color: var(--st-queued);
    opacity: 0.7;
  }
  .done {
    color: var(--st-done);
    border-color: rgba(96, 165, 250, 0.5);
  }
  .stopped {
    color: var(--st-stopped);
    border-color: rgba(251, 191, 36, 0.5);
  }
  .error {
    color: var(--st-error);
    border-color: rgba(248, 113, 113, 0.5);
    background: rgba(248, 113, 113, 0.08);
  }
  .rate-limited {
    color: var(--st-rate-limited);
    border-color: rgba(251, 191, 36, 0.5);
  }
  .needs-input {
    color: var(--color-accent-content);
    background: var(--st-needs-input);
    border-color: var(--st-needs-input);
  }
  .pulse {
    animation: pulse 1.05s ease-in-out infinite;
  }
  @keyframes pulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.5;
    }
  }
</style>
