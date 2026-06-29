<script lang="ts">
  import { ui } from "../lib/ui.svelte";
  import SessionForm from "./modals/SessionForm.svelte";
  import NewSessionWizard from "./modals/NewSessionWizard.svelte";
  import AdoptModal from "./modals/AdoptModal.svelte";
  import HistoryModal from "./modals/HistoryModal.svelte";
</script>

{#if ui.modal}
  {#if ui.modal.kind === "new"}
    <NewSessionWizard />
  {:else if ui.modal.kind === "adopt-form"}
    <NewSessionWizard adopt={{ cwd: ui.modal.cwd, resumeId: ui.modal.resumeId }} />
  {:else if ui.modal.kind === "edit"}
    <SessionForm session={ui.modal.session} />
  {:else if ui.modal.kind === "adopt"}
    <AdoptModal />
  {:else if ui.modal.kind === "history"}
    <HistoryModal sessionId={ui.modal.sessionId} />
  {/if}
{/if}
