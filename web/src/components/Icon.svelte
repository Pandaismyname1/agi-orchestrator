<script lang="ts" module>
  /** Inline stroke icons (Lucide-style). No emoji as structural icons. */
  export const ICONS = {
    play: "M7 4v16l13-8z",
    stop: "",
    edit: "M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z",
    trash: "M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M6 6l1 14a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-14",
    plus: "M12 5v14M5 12h14",
    download: "M12 3v12M8 11l4 4 4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2",
    pip: "",
    clock: "",
    bot: "",
    hand: "M7 11V6a1.5 1.5 0 0 1 3 0v4M10 10V4.5a1.5 1.5 0 0 1 3 0V10M13 10V6a1.5 1.5 0 0 1 3 0v6M16 8.5a1.5 1.5 0 0 1 3 0V14a6 6 0 0 1-6 6h-1a6 6 0 0 1-5.2-3L4 12.5a1.5 1.5 0 0 1 2.6-1.5L7 11",
    send: "M22 2 11 13M22 2l-7 20-4-9-9-4z",
    alert: "M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z",
    terminal: "",
    spark: "M12 3v3M12 18v3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M3 12h3M18 12h3M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1",
    x: "M18 6 6 18M6 6l12 12",
  } as const;

  export type IconName = keyof typeof ICONS;
</script>

<script lang="ts">
  interface Props {
    name: IconName;
    size?: number;
    class?: string;
  }
  let { name, size = 15, class: cls = "" }: Props = $props();
</script>

<svg
  class={cls}
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="1.8"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
>
  {#if name === "stop"}
    <rect x="6" y="6" width="12" height="12" rx="2" />
  {:else if name === "pip"}
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <rect x="12" y="11" width="7" height="5" rx="1" fill="currentColor" stroke="none" />
  {:else if name === "clock"}
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  {:else if name === "bot"}
    <rect x="4" y="8" width="16" height="11" rx="2" />
    <path d="M12 8V4M9 13h.01M15 13h.01M2 13h2M20 13h2" />
  {:else if name === "terminal"}
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M7 9l3 3-3 3M13 15h4" />
  {:else}
    <path d={ICONS[name]} />
  {/if}
</svg>
