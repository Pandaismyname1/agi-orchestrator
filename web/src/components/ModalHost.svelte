<script lang="ts">
  import { ui } from "../lib/ui.svelte";
  import SessionForm from "./modals/SessionForm.svelte";
  import NewSessionWizard from "./modals/NewSessionWizard.svelte";
  import AdoptModal from "./modals/AdoptModal.svelte";
  import HistoryModal from "./modals/HistoryModal.svelte";
  import SettingsModal from "./modals/SettingsModal.svelte";
  import AttachModal from "./modals/AttachModal.svelte";
  import ContinueForm from "./modals/ContinueForm.svelte";
  import LearnModal from "./modals/LearnModal.svelte";
  import TemplatesModal from "./modals/TemplatesModal.svelte";
  import WebhooksModal from "./modals/WebhooksModal.svelte";
  import WorkflowModal from "./modals/WorkflowModal.svelte";
  import AnalyticsModal from "./modals/AnalyticsModal.svelte";
</script>

{#if ui.modal}
  {#if ui.modal.kind === "new"}
    <NewSessionWizard template={ui.modal.template} />
  {:else if ui.modal.kind === "adopt-form"}
    <NewSessionWizard adopt={{ cwd: ui.modal.cwd, resumeId: ui.modal.resumeId }} />
  {:else if ui.modal.kind === "edit"}
    <SessionForm session={ui.modal.session} />
  {:else if ui.modal.kind === "adopt"}
    <AdoptModal />
  {:else if ui.modal.kind === "history"}
    <HistoryModal sessionId={ui.modal.sessionId} />
  {:else if ui.modal.kind === "settings"}
    <SettingsModal />
  {:else if ui.modal.kind === "attach"}
    <AttachModal />
  {:else if ui.modal.kind === "continue"}
    <ContinueForm session={ui.modal.session} />
  {:else if ui.modal.kind === "learn"}
    <LearnModal />
  {:else if ui.modal.kind === "templates"}
    <TemplatesModal />
  {:else if ui.modal.kind === "webhooks"}
    <WebhooksModal />
  {:else if ui.modal.kind === "workflow"}
    <WorkflowModal />
  {:else if ui.modal.kind === "analytics"}
    <AnalyticsModal />
  {/if}
{/if}
