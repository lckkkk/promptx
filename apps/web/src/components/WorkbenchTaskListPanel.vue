<script setup>
import { Blocks, CircleAlert, Clock3, GripVertical, LogOut, PencilLine, Plus, Settings2, Trash2 } from 'lucide-vue-next'
import { computed, ref, watch } from 'vue'
import { VueDraggable } from 'vue-draggable-plus'
import ConfirmDialog from './ConfirmDialog.vue'
import { formatDate, formatDateTime, useI18n } from '../composables/useI18n.js'

const props = defineProps({
  loadingTasks: {
    type: Boolean,
    default: false,
  },
  tasks: {
    type: Array,
    default: () => [],
  },
  codexSessions: {
    type: Array,
    default: () => [],
  },
  currentTaskSlug: {
    type: String,
    default: '',
  },
  editingTaskTitleSlug: {
    type: String,
    default: '',
  },
  draftTitle: {
    type: String,
    default: '',
  },
  currentTaskAutoTitle: {
    type: String,
    default: '',
  },
  creatingTask: {
    type: Boolean,
    default: false,
  },
  loadingTask: {
    type: Boolean,
    default: false,
  },
  uploading: {
    type: Boolean,
    default: false,
  },
  error: {
    type: String,
    default: '',
  },
  removingTask: {
    type: Boolean,
    default: false,
  },
  isCurrentTaskSending: {
    type: Boolean,
    default: false,
  },
  mobile: {
    type: Boolean,
    default: false,
  },
  multiUser: {
    type: Boolean,
    default: false,
  },
  currentUsername: {
    type: String,
    default: '',
  },
})

const emit = defineEmits([
  'open-settings',
  'create-task',
  'reorder-task',
  'select-task',
  'title-click',
  'title-blur',
  'cancel-title-edit',
  'update:draftTitle',
  'edit-task',
  'delete-task',
])

const { t } = useI18n()
const localTasks = ref([])
const selectedSessionFilter = ref('')
const showLogoutConfirm = ref(false)

watch(
  () => props.tasks,
  (tasks) => {
    localTasks.value = Array.isArray(tasks) ? [...tasks] : []
  },
  { immediate: true }
)

// 从 sessions 中建立 id -> title 的映射
const sessionTitleById = computed(() => {
  const map = new Map()
  if (Array.isArray(props.codexSessions)) {
    props.codexSessions.forEach((session) => {
      if (session?.id && session?.title) {
        map.set(session.id, session.title)
      }
    })
  }
  return map
})

// 已被任务使用的 sessions 列表（用于筛选下拉框）
const usedSessionOptions = computed(() => {
  const seen = new Set()
  const options = []
  const tasks = Array.isArray(props.tasks) ? props.tasks : []
  tasks.forEach((task) => {
    const sid = String(task?.codexSessionId || '').trim()
    if (sid && !seen.has(sid)) {
      const title = sessionTitleById.value.get(sid) || sid
      seen.add(sid)
      options.push({ id: sid, title })
    }
  })
  return options
})

// 经过筛选后的任务列表
const filteredTasks = computed(() => {
  const tasks = localTasks.value
  if (!selectedSessionFilter.value) return tasks
  return tasks.filter((task) => String(task?.codexSessionId || '').trim() === selectedSessionFilter.value)
})

// 获取任务的项目名（用于分行展示）
function getTaskSessionTitle(task) {
  const sessionId = String(task?.codexSessionId || '').trim()
  if (!sessionId) return ''
  return sessionTitleById.value.get(sessionId) || ''
}

// 获取任务的展示标题（纯任务名，不含项目名）
function getTaskDisplayTitle(task) {
  return task?.displayTitle || task?.title || task?.autoTitle || ''
}

function shouldEnableDrag(task) {
  return !props.mobile
    && Boolean(task?.slug)
    && task.slug !== props.editingTaskTitleSlug
    && props.tasks.length > 1
}

function getTaskCardClass(task) {
  if (task.slug === props.currentTaskSlug) {
    return 'workbench-task-card--active theme-card-selected'
  }

  if (task.sending) {
    return 'workbench-task-card--running theme-card-warning'
  }

  return 'theme-card-idle-muted'
}

function getTaskRunningBadgeClass() {
  return 'theme-status-warning'
}

function formatTaskUpdatedAt(task) {
  const value = new Date(task.updatedAt)
  if (Number.isNaN(value.getTime())) {
    return ''
  }

  return props.mobile
    ? formatDate(value.toISOString())
    : formatDateTime(value.toISOString(), {
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
}

function shouldShowWorkspaceBadge(task) {
  if (!task?.workspaceDiffSummary?.supported || !task?.workspaceDiffSummary?.fileCount) {
    return false
  }

  if (!props.mobile) {
    return true
  }

  return task.slug === props.currentTaskSlug || Boolean(task.sending)
}

function getTaskWorkspaceBadgeClass(task) {
  return task.slug === props.currentTaskSlug
    ? 'theme-badge-strong'
    : 'theme-badge-muted'
}

async function handleLogout() {
  await fetch('/logout', { method: 'POST' })
  window.location.href = '/login'
}
function handleDragEnd(event) {  if (props.mobile) {
    return
  }

  const oldIndex = Number(event?.oldIndex)
  const newIndex = Number(event?.newIndex)
  if (!Number.isInteger(oldIndex) || !Number.isInteger(newIndex) || oldIndex === newIndex) {
    return
  }

  emit('reorder-task', localTasks.value.map((task) => String(task?.slug || '').trim()).filter(Boolean))
}</script>

<template>
  <aside class="panel flex h-full min-h-0 flex-col overflow-hidden">
    <div class="workbench-panel-header theme-divider border-b px-4 py-4" :class="mobile ? 'workbench-mobile-header px-3 py-3' : ''">
      <div class="flex items-center justify-between gap-3">
        <div class="flex min-h-8 items-center">
          <div class="theme-heading inline-flex items-center gap-2 text-sm font-medium">
            <Blocks class="h-4 w-4" />
            <span>{{ t('workbench.title') }}</span>
          </div>
        </div>
        <button
          type="button"
          class="tool-button inline-flex items-center gap-2 whitespace-nowrap px-3 py-2 text-xs"
          :title="t('workbench.settings')"
          @click="emit('open-settings')"
        >
          <Settings2 class="h-4 w-4" />
          <span :class="mobile ? 'whitespace-nowrap' : 'hidden whitespace-nowrap sm:inline'">{{ t('workbench.settings') }}</span>
        </button>
      </div>
      <button
        type="button"
        class="tool-button tool-button-primary mt-4 inline-flex w-full items-center justify-center gap-2 whitespace-nowrap px-3 py-2 text-sm"
        :disabled="creatingTask || uploading"
        :title="creatingTask ? t('workbench.creatingTask') : t('workbench.createTask')"
        @click="emit('create-task')"
      >
        <Plus class="h-4 w-4" />
        <span class="whitespace-nowrap">{{ creatingTask ? t('workbench.creatingTask') : t('workbench.createTask') }}</span>
      </button>
      <div v-if="usedSessionOptions.length > 0" class="mt-3">
        <div class="session-filter-select-wrap">
          <select
            v-model="selectedSessionFilter"
            class="session-filter-select"
          >
            <option value="">全部项目</option>
            <option v-for="option in usedSessionOptions" :key="option.id" :value="option.id">
              {{ option.title }}
            </option>
          </select>
          <svg class="session-filter-select-icon" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </div>
      </div>
    </div>

    <div class="min-h-0 flex-1 overflow-y-auto px-3 py-3">
      <div v-if="loadingTasks && !tasks.length" class="theme-empty-state px-3 py-4 text-sm">
        {{ t('workbench.loadingTasks') }}
      </div>

      <VueDraggable
        v-else
        v-model="localTasks"
        class="space-y-2"
        :class="mobile ? 'space-y-1.5' : ''"
        :animation="180"
        :disabled="mobile || tasks.length <= 1"
        handle=".task-drag-handle"
        ghost-class="workbench-task-card--ghost"
        chosen-class="workbench-task-card--chosen"
        drag-class="workbench-task-card--dragging"
        fallback-tolerance="6"
        @end="handleDragEnd"
      >
        <article
          v-for="task in filteredTasks"
          :key="task.slug"
          class="workbench-task-card group relative cursor-default rounded-sm border px-3 py-3 transition"
          :class="[getTaskCardClass(task), mobile ? 'workbench-task-card--mobile px-3 py-2.5' : '']"
          @click="emit('select-task', task.slug)"
        >
          <span
            v-if="task.slug === currentTaskSlug"
            class="theme-selection-indicator absolute inset-y-2 left-0 w-1 rounded-full"
          />
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0 flex-1 overflow-hidden">
              <div
                v-if="getTaskSessionTitle(task)"
                class="task-session-label mb-1 flex items-center gap-1.5 truncate"
              >
                <button
                  v-if="!mobile"
                  type="button"
                  class="task-drag-handle inline-flex h-4 w-4 shrink-0 cursor-grab items-center justify-center rounded-sm opacity-45 transition hover:opacity-80 active:cursor-grabbing"
                  :title="t('workbench.dragToReorder')"
                  :aria-label="t('workbench.dragToReorder')"
                  tabindex="-1"
                  @click.stop
                >
                  <GripVertical class="h-3.5 w-3.5" />
                </button>
                <span class="truncate">{{ getTaskSessionTitle(task) }}</span>
              </div>
              <div class="min-w-0 overflow-hidden">
                <div class="flex items-start gap-1.5" :class="getTaskSessionTitle(task) ? '' : 'gap-2'">
                  <button
                    v-if="!mobile && !getTaskSessionTitle(task)"
                    type="button"
                    class="task-drag-handle mt-0.5 inline-flex h-4 w-4 shrink-0 cursor-grab items-center justify-center rounded-sm opacity-45 transition hover:opacity-80 active:cursor-grabbing"
                    :title="t('workbench.dragToReorder')"
                    :aria-label="t('workbench.dragToReorder')"
                    tabindex="-1"
                    @click.stop
                  >
                    <GripVertical class="h-3.5 w-3.5" />
                  </button>
                  <div class="min-w-0 flex-1 overflow-hidden">
                    <input
                      v-if="task.slug === currentTaskSlug && editingTaskTitleSlug === task.slug"
                      :value="draftTitle"
                      type="text"
                      maxlength="140"
                      data-task-title-input="current"
                      class="block h-5 min-h-0 w-full appearance-none border-0 bg-transparent p-0 text-left text-sm font-semibold leading-5 outline-none placeholder:text-[var(--theme-textMuted)]"
                      :placeholder="currentTaskAutoTitle || t('workbench.untitledTask')"
                      @click.stop
                      @input="emit('update:draftTitle', $event.target.value)"
                      @keydown.enter.prevent="$event.target.blur()"
                      @keydown.esc.prevent="emit('cancel-title-edit')"
                      @blur="emit('title-blur')"
                    >
                    <button
                      v-else
                      type="button"
                      class="inline-flex h-5 w-full items-center gap-1.5 truncate bg-transparent p-0 text-left text-sm leading-5"
                      :class="task.slug === currentTaskSlug ? 'font-semibold' : 'font-medium'"
                      :title="getTaskDisplayTitle(task)"
                      @click.stop="emit('title-click', task.slug)"
                    >
                      <Clock3
                        v-if="task.automation?.enabled"
                        class="h-3.5 w-3.5 shrink-0 opacity-70"
                      />
                      <span class="min-w-0 truncate">{{ getTaskDisplayTitle(task) }}</span>
                    </button>
                  </div>
                </div>
              </div>
            </div>
            <div class="flex shrink-0 items-center gap-1.5 text-[10px] uppercase tracking-[0.18em] opacity-80">
              <span
                v-if="task.sending"
                class="inline-flex items-center gap-1.5 rounded-sm border border-dashed px-1.5 py-0.5"
                :class="[getTaskRunningBadgeClass(), mobile ? 'text-[9px] tracking-[0.14em]' : '']"
              >
                <span class="task-loading-dots" aria-hidden="true">
                  <span class="task-loading-dots__dot"></span>
                  <span class="task-loading-dots__dot"></span>
                  <span class="task-loading-dots__dot"></span>
                </span>
                <span>{{ t('workbench.running') }}</span>
              </span>
            </div>
          </div>
          <div class="workbench-task-card__preview mt-2 truncate text-xs opacity-80" :class="mobile ? 'mt-1.5 text-[11px]' : ''">{{ task.lastPromptPreview || t('workbench.noMessagesYet') }}</div>
          <div class="mt-2 flex items-center justify-between gap-3" :class="mobile ? 'mt-1.5' : ''">
            <div class="min-w-0 text-[11px] opacity-70" :class="mobile ? 'text-[10px] opacity-60' : ''">{{ formatTaskUpdatedAt(task) }}</div>
            <div class="flex shrink-0 items-center gap-1.5 text-[10px] uppercase tracking-[0.18em] opacity-80" :class="mobile ? 'tracking-[0.12em]' : ''">
              <span
                v-if="shouldShowWorkspaceBadge(task)"
                class="inline-flex items-center gap-1 rounded-sm border border-dashed px-1.5 py-0.5"
                :class="[getTaskWorkspaceBadgeClass(task), mobile ? 'text-[9px]' : '']"
              >
                <span>{{ t('workbench.filesCount', { count: task.workspaceDiffSummary?.fileCount || 0 }) }}</span>
              </span>
            </div>
          </div>
        </article>
      </VueDraggable>
    </div>

    <div class="theme-divider border-t px-3 py-3">
      <div v-if="error" class="theme-danger-text mb-3 inline-flex min-w-0 items-start gap-2 text-xs">
        <CircleAlert class="mt-0.5 h-4 w-4 shrink-0" />
        <span class="min-w-0 break-words">{{ error }}</span>
      </div>
      <div v-if="multiUser" class="mb-2 flex items-center justify-between gap-2">
        <span class="min-w-0 truncate text-xs opacity-60">{{ currentUsername }}</span>
        <button
          type="button"
          class="tool-button inline-flex shrink-0 items-center gap-1.5 px-2 py-1.5 text-xs"
          title="退出登录"
          @click="showLogoutConfirm = true"
        >
          <LogOut class="h-3.5 w-3.5" />
          <span>退出</span>
        </button>
      </div>
      <div class="grid grid-cols-2 gap-2">
        <button
          type="button"
          class="tool-button inline-flex w-full items-center justify-center gap-2 whitespace-nowrap px-3 py-2 text-sm"
          :disabled="!currentTaskSlug || removingTask || creatingTask"
          :title="t('workbench.editTask')"
          @click="emit('edit-task')"
        >
          <PencilLine class="h-4 w-4" />
          <span class="whitespace-nowrap">{{ t('workbench.editTask') }}</span>
        </button>
        <button
          type="button"
          class="tool-button tool-button-danger-subtle inline-flex w-full items-center justify-center gap-2 whitespace-nowrap px-3 py-2 text-sm"
          :disabled="!currentTaskSlug || removingTask || creatingTask || isCurrentTaskSending"
          :title="removingTask ? t('workbench.deletingTask') : t('workbench.deleteTask')"
          @click="emit('delete-task')"
        >
          <Trash2 class="h-4 w-4" />
          <span class="whitespace-nowrap">{{ removingTask ? t('workbench.deletingTask') : t('workbench.deleteTask') }}</span>
        </button>
      </div>
    </div>
  </aside>

  <ConfirmDialog
    :open="showLogoutConfirm"
    title="退出登录"
    description="确定要退出当前账号吗？"
    confirm-text="退出"
    cancel-text="取消"
    @confirm="handleLogout"
    @cancel="showLogoutConfirm = false"
  />
</template>

<style scoped>
.workbench-task-card--ghost {
  opacity: 0.38;
}

.workbench-task-card--chosen {
  box-shadow:
    0 0 0 1px color-mix(in srgb, var(--theme-accent) 28%, transparent 72%),
    0 10px 28px color-mix(in srgb, var(--theme-accent) 12%, transparent 88%);
}

.workbench-task-card--dragging {
  opacity: 0.96;
  transform: rotate(1deg);
}

.session-filter-select-wrap {
  position: relative;
  display: flex;
  align-items: center;
}

.session-filter-select {
  width: 100%;
  appearance: none;
  -webkit-appearance: none;
  padding: 0.3rem 2rem 0.3rem 0.625rem;
  font-size: 0.75rem;
  line-height: 1.4;
  border-radius: 6px;
  border: 1px solid var(--theme-border);
  background: var(--theme-surface);
  color: var(--theme-text);
  outline: none;
  cursor: pointer;
  transition: border-color 0.15s;
}

.session-filter-select:hover {
  border-color: var(--theme-accent);
}

.session-filter-select:focus {
  border-color: var(--theme-accent);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--theme-accent) 15%, transparent 85%);
}

.session-filter-select-icon {
  position: absolute;
  right: 0.5rem;
  width: 14px;
  height: 14px;
  pointer-events: none;
  color: var(--theme-textMuted);
}

.task-session-label {
  font-size: 0.68rem;
  line-height: 1.3;
  color: var(--theme-accent);
  opacity: 0.75;
  font-weight: 500;
  letter-spacing: 0.01em;
}

</style>
