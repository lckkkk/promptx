<script setup>
import { Plus } from 'lucide-vue-next'

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

function getCardClass(session) {
  if (props.mode === 'edit' && props.editingSessionId === session.id) {
    return 'border-[var(--theme-accent)] bg-[var(--theme-appPanelStrong)] shadow-sm'
  }

  if (props.isSessionRunning(session.id)) {
    return 'theme-status-warning'
  }

  if (props.isCurrentSession(session.id)) {
    return 'theme-status-info'
  }

  return 'border-[var(--theme-borderDefault)] bg-[var(--theme-appPanelStrong)] hover:border-[var(--theme-borderStrong)] hover:bg-[var(--theme-appPanel)]'
}
</script>

<template>
  <div class="flex items-center justify-between gap-3">
    <div>
      <div class="theme-heading text-sm font-medium">项目列表</div>
      <p v-if="!hasSessions" class="theme-muted-text mt-1 text-xs">
        还没有项目，先新建一个固定工作目录。
      </p>
    </div>
    <button
      type="button"
      class="tool-button tool-button-primary inline-flex items-center gap-2 px-3 py-2 text-xs"
      :disabled="busy"
      @click="emit('create')"
    >
      <Plus class="h-4 w-4" />
      <span>新建</span>
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
        class="absolute inset-y-3 left-0 w-1 rounded-full bg-[var(--theme-accent)]"
      />
      <div class="w-full text-left">
        <div class="theme-heading flex flex-wrap items-center gap-2 text-sm font-medium">
          <span class="truncate">{{ session.title || '未命名项目' }}</span>
          <span
            v-if="!mobile && isCurrentSession(session.id)"
            class="theme-status-info rounded-sm border border-dashed px-1.5 py-0.5 text-[10px]"
          >
            当前
          </span>
          <span
            class="inline-flex items-center gap-1 rounded-sm border border-dashed px-1.5 py-0.5 text-[10px]"
            :class="getRuntimeStatusClass(session.id)"
          >
            <span v-if="isSessionRunning(session.id)" class="h-1.5 w-1.5 rounded-full bg-current animate-pulse" />
            {{ getRuntimeStatusLabel(session.id) }}
          </span>
          <span class="rounded-sm border border-dashed px-1.5 py-0.5 text-[10px]" :class="getThreadStatusClass(session)">
            {{ getThreadStatusLabel(session) }}
          </span>
        </div>
        <div class="theme-muted-text mt-2 break-all font-mono text-[11px] leading-5">
          {{ session.cwd }}
        </div>
        <div v-if="!mobile" class="theme-muted-text mt-2 text-[11px]">
          最近更新：{{ formatUpdatedAt(session.updatedAt) }}
        </div>
      </div>
    </article>
  </div>
</template>
