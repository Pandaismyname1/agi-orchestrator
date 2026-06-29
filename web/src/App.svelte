<script lang="ts">
  import { onMount } from "svelte";
  import { wsStore } from "./lib/ws.svelte";
  import { ui } from "./lib/ui.svelte";
  import { pip } from "./lib/pip.svelte";
  import Header from "./components/Header.svelte";
  import Fleet from "./components/Fleet.svelte";
  import Detail from "./components/Detail.svelte";
  import ModalHost from "./components/ModalHost.svelte";
  import Toast from "./components/Toast.svelte";

  onMount(() => {
    wsStore.onError((msg) => ui.toast(msg));
    pip.onFocus((id) => {
      ui.focusId = id;
      wsStore.send({ type: "focus", id });
    });
    wsStore.connect();
  });

  let snap = $derived(wsStore.snapshot);
  let sessions = $derived(snap?.sessions ?? []);

  // Default the focus to the first session, and feed the PiP/notifier each snapshot.
  $effect(() => {
    if (!snap) return;
    if (!ui.focusId && sessions[0]) ui.focusId = sessions[0].id;
    pip.update(snap);
  });

  let focused = $derived(sessions.find((s) => s.id === ui.focusId));
</script>

<div class="shell">
  <Header provider={snap?.provider} budget={snap?.budget} {sessions} />
  <main>
    <Fleet {sessions} />
    <Detail session={focused} focus={snap?.focus} />
  </main>
</div>

<ModalHost />
<Toast />

<style>
  .shell {
    height: 100vh;
    display: flex;
    flex-direction: column;
    color: var(--color-base-content);
  }
  main {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
</style>
