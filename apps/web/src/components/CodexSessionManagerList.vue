<script setup>
import { Plus } from 'lucide-vue-next'
import { useI18n } from '../composables/useI18n.js'
import { getAgentEngineLabel } from '../lib/agentEngines.js'

const props = defineProps({
  busy: {
    type: Boolean,
    default: false,
  },
  editingSessionId: {
    type: String,
    default: '',
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
  hasSessions: {
    type: Boolean,
    default: false,
  },
  isCurrentSession: {
    type: Function,
    default: () => false,
  },
  isSessionRunning: {
    type: Function,
    default: () => false,
  },
  mode: {
    type: String,
    default: 'edit',
  },
  mobile: {
    type: Boolean,
    default: false,
  },
  sessions: {
    type: Array,
    default: () => [],
  },
})

const emit = defineEmits(['create', 'select'])
const { t } = useI18n()

function getCardClass(session) {
  if (props.mode === 'edit' && props.editingSessionId === session.id) {
    return 'theme-card-selected'
  }

  if (props.isSessionRunning(session.id)) {
    return 'theme-card-warning'
  }

  return 'theme-card-idle-strong'
}

function getSessionStateLabel(session) {
  return props.isCurrentSession(session.id) ? t('projectManager.current') : t('projectManager.regular')
}

function getSessionStateClass(session) {
  return props.isCurrentSession(session.id) ? 'theme-status-info' : 'theme-status-neutral'
}
</script>

<template>
  <div class="flex items-center justify-between gap-3">
    <div>
      <div class="theme-heading text-sm font-medium">{{ t('projectManager.projectList') }}</div>
      <p v-if="!hasSessions" class="theme-muted-text mt-1 text-xs">{{ t('projectManager.noProjects') }}</p>
    </div>
    <button
      type="button"
      class="tool-button tool-button-primary inline-flex items-center gap-2 px-3 py-2 text-xs"
      :disabled="busy"
      @click="emit('create')"
    >
      <Plus class="h-4 w-4" />
      <span>{{ t('projectManager.create') }}</span>
    </button>
  </div>

  <div
    class="mt-4 space-y-2"
    :class="mobile ? 'min-h-0 flex-1 overflow-y-auto' : 'max-h-52 overflow-y-auto pr-1 sm:max-h-64 lg:max-h-[calc(88vh-11rem)]'"
  >
    <article
      v-for="session in sessions"
      :key="session.id"
      class="relative cursor-pointer rounded-sm border p-3 transition"
      :class="getCardClass(session)"
      @click="emit('select', session.id)"
    >
      <span
        v-if="mode === 'edit' && editingSessionId === session.id"
        class="theme-selection-indicator absolute inset-y-3 left-0 w-1 rounded-full"
      />
      <div class="flex w-full flex-col gap-2 text-left">
        <div class="theme-heading min-w-0 text-sm font-medium">
          <span class="block truncate" :title="session.title || t('projectManager.untitledProject')">
            {{ session.title || t('projectManager.untitledProject') }}
          </span>
        </div>
        <div
          class="theme-muted-text break-all font-mono text-[11px] leading-5"
          :title="session.cwd"
        >
          {{ session.cwd }}
        </div>
        <div class="theme-muted-text flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] leading-5">
          <span>{{ getAgentEngineLabel(session.engine) }}</span>
          <span v-if="!mobile" aria-hidden="true">·</span>
          <span v-if="!mobile">{{ formatUpdatedAt(session.updatedAt) }}</span>
        </div>
        <div class="flex flex-wrap items-center gap-2 pt-1">
          <span
            class="inline-flex shrink-0 whitespace-nowrap rounded-sm border border-dashed px-1.5 py-0.5 text-[10px]"
            :class="getSessionStateClass(session)"
          >
            {{ getSessionStateLabel(session) }}
          </span>
          <span
            class="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-sm border border-dashed px-1.5 py-0.5 text-[10px]"
            :class="getRuntimeStatusClass(session.id)"
          >
            <span v-if="isSessionRunning(session.id)" class="h-1.5 w-1.5 rounded-full bg-current animate-pulse" />
            {{ getRuntimeStatusLabel(session.id) }}
          </span>
          <span
            class="inline-flex shrink-0 whitespace-nowrap rounded-sm border border-dashed px-1.5 py-0.5 text-[10px]"
            :class="getThreadStatusClass(session)"
          >
            {{ getThreadStatusLabel(session) }}
          </span>
        </div>
      </div>
    </article>
  </div>
</template>
