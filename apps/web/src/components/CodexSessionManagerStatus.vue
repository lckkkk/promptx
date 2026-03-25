<script setup>
import { Info } from 'lucide-vue-next'
import { useI18n } from '../composables/useI18n.js'
import { getAgentEngineLabel } from '../lib/agentEngines.js'

defineProps({
  activeSession: {
    type: Object,
    default: null,
  },
  formatUpdatedAt: {
    type: Function,
    default: (value) => value,
  },
  getRuntimeStatusClass: {
    type: Function,
    default: () => '',
  },
  getRuntimeStatusLabel: {
    type: Function,
    default: () => '',
  },
  getThreadStatusClass: {
    type: Function,
    default: () => '',
  },
  getThreadStatusLabel: {
    type: Function,
    default: () => '',
  },
  isCurrentSession: {
    type: Function,
    default: () => false,
  },
  isSessionRunning: {
    type: Function,
    default: () => false,
  },
})
const { t } = useI18n()
</script>

<template>
  <div class="space-y-3">
    <div class="dashed-panel px-3 py-3">
      <div class="theme-muted-text text-[11px]">{{ t('projectManager.runtimeStatus') }}</div>
      <div class="mt-2 flex flex-wrap gap-2">
        <span class="inline-flex items-center gap-1 rounded-sm border border-dashed px-2 py-1 text-xs" :class="getRuntimeStatusClass(activeSession?.id)">
          <span v-if="isSessionRunning(activeSession?.id)" class="h-1.5 w-1.5 rounded-full bg-current animate-pulse" />
          {{ getRuntimeStatusLabel(activeSession?.id) }}
        </span>
        <span class="inline-flex items-center gap-1 rounded-sm border border-dashed px-2 py-1 text-xs" :class="getThreadStatusClass(activeSession)">
          {{ getThreadStatusLabel(activeSession) }}
        </span>
        <span
          v-if="activeSession?.id && isCurrentSession(activeSession.id)"
          class="theme-status-info inline-flex items-center gap-1 rounded-sm border border-dashed px-2 py-1 text-xs"
        >
          {{ t('projectManager.currentProject') }}
        </span>
      </div>
    </div>

    <div class="dashed-panel px-3 py-3">
      <div class="theme-muted-text text-[11px]">{{ t('projectManager.engine') }}</div>
      <div class="mt-2 text-sm text-[var(--theme-textPrimary)]">
        {{ getAgentEngineLabel(activeSession?.engine) }}
      </div>
    </div>

    <div class="dashed-panel px-3 py-3">
      <div class="theme-muted-text text-[11px]">{{ t('projectManager.workingDirectory') }}</div>
      <div class="mt-2 break-all font-mono text-xs leading-6 text-[var(--theme-textPrimary)]">
        {{ activeSession?.cwd || t('projectManager.notSet') }}
      </div>
    </div>

    <div class="dashed-panel px-3 py-3">
      <div class="theme-muted-text text-[11px]">{{ t('projectManager.updatedAt') }}</div>
      <div class="mt-2 text-sm text-[var(--theme-textPrimary)]">
        {{ formatUpdatedAt(activeSession?.updatedAt) }}
      </div>
    </div>

    <div class="dashed-panel px-3 py-3">
      <div class="theme-muted-text inline-flex items-center gap-2 text-[11px]">
        <Info class="h-3.5 w-3.5" />
        <span>{{ t('projectManager.note') }}</span>
      </div>
      <p class="mt-2 text-xs leading-6 text-[var(--theme-textSecondary)]">
        {{ t('projectManager.noteDescription') }}
      </p>
    </div>
  </div>
</template>
