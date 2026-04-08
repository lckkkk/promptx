<script setup>
import { Blocks, CircleAlert, Clock3, GripVertical, LogOut, PencilLine, Plus, Settings2, Trash2 } from 'lucide-vue-next'
import { computed, ref, watch } from 'vue'
import { VueDraggable } from 'vue-draggable-plus'
import ConfirmDialog from './ConfirmDialog.vue'
import { formatDate, formatDateTime, useI18n } from '../composables/useI18n.js'
import { filterTasksBySessionIds, resolveSwipeEndOffset } from '../lib/workbenchTaskList.js'

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
  'manage-projects',
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
const selectedSessionFilters = ref([])
const showSessionFilterMenu = ref(false)
const showLogoutConfirm = ref(false)
const swipeOpenTaskSlug = ref('')
const swipeOffsetBySlug = ref({})
const activeTouch = ref({
  slug: '',
  startX: 0,
  startY: 0,
  offset: 0,
  tracking: false,
  horizontal: false,
})
const PROJECT_ACCENT_PALETTE = [
  { accent: '#475569', tint: 'rgba(71, 85, 105, 0.16)' },
  { accent: '#0f766e', tint: 'rgba(15, 118, 110, 0.16)' },
  { accent: '#1d4ed8', tint: 'rgba(29, 78, 216, 0.16)' },
  { accent: '#7c3aed', tint: 'rgba(124, 58, 237, 0.16)' },
  { accent: '#c2410c', tint: 'rgba(194, 65, 12, 0.16)' },
  { accent: '#3f6212', tint: 'rgba(63, 98, 18, 0.16)' },
  { accent: '#be185d', tint: 'rgba(190, 24, 93, 0.16)' },
  { accent: '#0369a1', tint: 'rgba(3, 105, 161, 0.16)' },
]

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

watch(usedSessionOptions, (options) => {
  const validIds = new Set(options.map((option) => option.id))
  selectedSessionFilters.value = selectedSessionFilters.value.filter((id) => validIds.has(id))
})

// 经过筛选后的任务列表
const filteredTasks = computed(() => {
  return filterTasksBySessionIds(localTasks.value, selectedSessionFilters.value)
})

const selectedSessionFilterLabel = computed(() => {
  if (!selectedSessionFilters.value.length) {
    return t('workbench.allProjects')
  }

  if (selectedSessionFilters.value.length === 1) {
    const option = usedSessionOptions.value.find((item) => item.id === selectedSessionFilters.value[0])
    return option?.title || t('workbench.project')
  }

  return t('workbench.selectedProjects', { count: selectedSessionFilters.value.length })
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

function getTaskProjectKey(task) {
  const sessionId = String(task?.codexSessionId || '').trim()
  if (sessionId) {
    return sessionId
  }
  return String(getTaskSessionTitle(task) || '').trim()
}

function hashProjectKey(input = '') {
  let hash = 0
  for (const char of String(input)) {
    hash = ((hash << 5) - hash) + char.charCodeAt(0)
    hash |= 0
  }
  return Math.abs(hash)
}

function getTaskProjectTone(task) {
  const key = getTaskProjectKey(task)
  if (!key) {
    return null
  }
  return PROJECT_ACCENT_PALETTE[hashProjectKey(key) % PROJECT_ACCENT_PALETTE.length]
}

function getTaskProjectStyle(task) {
  const tone = getTaskProjectTone(task)
  if (!tone) {
    return {}
  }

  return {
    '--task-project-accent': tone.accent,
    '--task-project-tint': tone.tint,
  }
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

function toggleSessionFilterMenu() {
  showSessionFilterMenu.value = !showSessionFilterMenu.value
}

function toggleSessionFilter(sessionId = '') {
  const normalizedSessionId = String(sessionId || '').trim()
  if (!normalizedSessionId) {
    return
  }

  if (selectedSessionFilters.value.includes(normalizedSessionId)) {
    selectedSessionFilters.value = selectedSessionFilters.value.filter((id) => id !== normalizedSessionId)
    return
  }

  selectedSessionFilters.value = [...selectedSessionFilters.value, normalizedSessionId]
}

function clearSessionFilters() {
  selectedSessionFilters.value = []
}

function closeSwipeTask() {
  swipeOpenTaskSlug.value = ''
  swipeOffsetBySlug.value = {}
  activeTouch.value = {
    slug: '',
    startX: 0,
    startY: 0,
    offset: 0,
    tracking: false,
    horizontal: false,
  }
}

function setSwipeOffset(taskSlug = '', offset = 0) {
  const normalizedTaskSlug = String(taskSlug || '').trim()
  if (!normalizedTaskSlug) {
    return
  }

  swipeOffsetBySlug.value = {
    ...swipeOffsetBySlug.value,
    [normalizedTaskSlug]: Math.max(0, Math.min(88, Number(offset) || 0)),
  }
}

function getSwipeOffset(task) {
  return Number(swipeOffsetBySlug.value[String(task?.slug || '').trim()] || 0)
}

function getSwipeCardStyle(task) {
  const offset = getSwipeOffset(task)
  if (!offset) {
    return {}
  }

  return {
    transform: `translateX(-${offset}px)`,
  }
}

function handleTaskTouchStart(task, event) {
  if (!props.mobile) {
    return
  }

  const touch = event.touches?.[0]
  if (!touch) {
    return
  }

  const slug = String(task?.slug || '').trim()
  if (!slug) {
    return
  }

  if (swipeOpenTaskSlug.value && swipeOpenTaskSlug.value !== slug) {
    closeSwipeTask()
  }

  activeTouch.value = {
    slug,
    startX: touch.clientX,
    startY: touch.clientY,
    offset: getSwipeOffset(task),
    tracking: true,
    horizontal: false,
  }
}

function handleTaskTouchMove(task, event) {
  if (!props.mobile || !activeTouch.value.tracking || activeTouch.value.slug !== String(task?.slug || '').trim()) {
    return
  }

  const touch = event.touches?.[0]
  if (!touch) {
    return
  }

  const deltaX = touch.clientX - activeTouch.value.startX
  const deltaY = touch.clientY - activeTouch.value.startY

  if (!activeTouch.value.horizontal) {
    if (Math.abs(deltaY) > Math.abs(deltaX)) {
      activeTouch.value.tracking = false
      return
    }

    activeTouch.value.horizontal = true
  }

  if (activeTouch.value.horizontal) {
    event.preventDefault()
  }

  const nextOffset = activeTouch.value.offset - deltaX
  setSwipeOffset(task.slug, nextOffset)
}

function handleTaskTouchEnd(task) {
  if (!props.mobile || activeTouch.value.slug !== String(task?.slug || '').trim()) {
    return
  }

  const offset = getSwipeOffset(task)
  const nextOffset = resolveSwipeEndOffset(offset)
  if (nextOffset > 0) {
    setSwipeOffset(task.slug, nextOffset)
    swipeOpenTaskSlug.value = String(task?.slug || '').trim()
  } else {
    setSwipeOffset(task.slug, 0)
    swipeOpenTaskSlug.value = ''
  }

  activeTouch.value = {
    slug: '',
    startX: 0,
    startY: 0,
    offset: 0,
    tracking: false,
    horizontal: false,
  }
}

function handleTaskCardClick(taskSlug = '') {
  const normalizedTaskSlug = String(taskSlug || '').trim()
  if (!normalizedTaskSlug) {
    return
  }

  if (props.mobile && swipeOpenTaskSlug.value && swipeOpenTaskSlug.value === normalizedTaskSlug) {
    closeSwipeTask()
    return
  }

  emit('select-task', normalizedTaskSlug)
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
      <div class="flex min-h-8 min-w-0 items-center">
        <div class="theme-heading inline-flex min-w-0 items-center gap-2 text-sm font-medium">
          <Blocks class="h-4 w-4 shrink-0" />
          <span class="truncate">{{ t('workbench.title') }}</span>
        </div>
      </div>

      <div class="mt-3 grid grid-cols-2 gap-2">
        <button
          type="button"
          class="tool-button inline-flex min-w-0 items-center justify-center gap-2 whitespace-nowrap px-2.5 py-2 text-xs sm:px-3"
          :title="t('workbench.project')"
          @click="emit('manage-projects')"
        >
          <PencilLine class="h-4 w-4 shrink-0" />
          <span class="truncate">{{ t('workbench.project') }}</span>
        </button>
        <button
          type="button"
          class="tool-button inline-flex min-w-0 items-center justify-center gap-2 whitespace-nowrap px-2.5 py-2 text-xs sm:px-3"
          :title="t('workbench.settings')"
          @click="emit('open-settings')"
        >
          <Settings2 class="h-4 w-4 shrink-0" />
          <span class="truncate">{{ t('workbench.settings') }}</span>
        </button>
      </div>
      <button
        type="button"
        class="tool-button tool-button-primary mt-2 inline-flex w-full items-center justify-center gap-2 whitespace-nowrap px-3 py-2 text-sm"
        :disabled="creatingTask || uploading"
        :title="creatingTask ? t('workbench.creatingTask') : t('workbench.createTask')"
        @click="emit('create-task')"
      >
        <Plus class="h-4 w-4 shrink-0" />
        <span class="truncate">{{ creatingTask ? t('workbench.creatingTask') : t('workbench.createTask') }}</span>
      </button>
      <div v-if="usedSessionOptions.length > 0" class="mt-3">
        <div class="session-filter-shell rounded-sm border p-1.5">
          <div class="session-filter-select-wrap">
            <button
              type="button"
              class="session-filter-button"
              :class="showSessionFilterMenu ? 'session-filter-button--open' : ''"
              @click="toggleSessionFilterMenu"
            >
              <span class="truncate">{{ selectedSessionFilterLabel }}</span>
              <span class="session-filter-button__meta">
                {{ selectedSessionFilters.length ? selectedSessionFilters.length : usedSessionOptions.length }}
              </span>
            </button>
            <div v-if="showSessionFilterMenu" class="session-filter-menu">
              <div class="session-filter-menu__header">
                <span>{{ t('workbench.projectFilter') }}</span>
                <button type="button" class="session-filter-clear" @click="clearSessionFilters">
                  {{ t('workbench.clearProjectFilter') }}
                </button>
              </div>
              <label
                v-for="option in usedSessionOptions"
                :key="option.id"
                class="session-filter-option"
              >
                <input
                  :checked="selectedSessionFilters.includes(option.id)"
                  type="checkbox"
                  @change="toggleSessionFilter(option.id)"
                >
                <span class="truncate">{{ option.title }}</span>
              </label>
            </div>
          </div>
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
        <div
          v-for="task in filteredTasks"
          :key="task.slug"
          class="task-swipe-row relative overflow-hidden rounded-sm"
          @touchstart.passive="handleTaskTouchStart(task, $event)"
          @touchmove="handleTaskTouchMove(task, $event)"
          @touchend.passive="handleTaskTouchEnd(task)"
          @touchcancel.passive="handleTaskTouchEnd(task)"
        >
          <div
            v-if="mobile"
            class="task-swipe-action"
            :class="getSwipeOffset(task) > 0 ? 'task-swipe-action--visible' : ''"
          >
            <button
              type="button"
              class="task-swipe-delete"
              :disabled="removingTask || creatingTask || task.sending"
              @click.stop="closeSwipeTask(); emit('delete-task', task.slug)"
            >
              <Trash2 class="h-4 w-4" />
              <span>{{ t('workbench.deleteTask') }}</span>
            </button>
          </div>
          <article
            class="workbench-task-card group relative cursor-default rounded-sm border px-3 py-3 transition"
            :class="[getTaskCardClass(task), mobile ? 'workbench-task-card--mobile px-3 py-2.5' : '']"
            :style="getSwipeCardStyle(task)"
            @click="handleTaskCardClick(task.slug)"
          >
            <span
              v-if="task.slug === currentTaskSlug"
              class="theme-selection-indicator absolute inset-y-2 left-0 w-1 rounded-full"
            />
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0 flex-1 overflow-hidden">
                <div
                  v-if="getTaskSessionTitle(task)"
                  class="task-session-label mb-1 inline-flex max-w-full items-center gap-1.5 truncate rounded-sm border px-2 py-1"
                  :style="getTaskProjectStyle(task)"
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
        </div>
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
}

.session-filter-shell {
  border-color: var(--theme-borderDefault);
  background: color-mix(in srgb, var(--theme-appPanelMuted) 65%, transparent);
}

.session-filter-button {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.55rem;
  padding: 0.32rem 0.55rem;
  font-size: 0.72rem;
  line-height: 1.3;
  border-radius: 6px;
  border: 1px solid var(--theme-border);
  background: var(--theme-surface);
  color: var(--theme-text);
  text-align: left;
  transition: border-color 0.15s, background 0.15s;
}

.session-filter-button:hover,
.session-filter-button--open {
  border-color: var(--theme-accent);
}

.session-filter-button__meta {
  flex-shrink: 0;
  min-width: 1.2rem;
  padding: 0.02rem 0.34rem;
  border-radius: 999px;
  background: var(--theme-appPanelMuted);
  color: var(--theme-textMuted);
  text-align: center;
}

.session-filter-menu {
  position: absolute;
  z-index: 10;
  top: calc(100% + 0.35rem);
  left: 0;
  right: 0;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  padding: 0.5rem;
  border: 1px solid var(--theme-border);
  border-radius: 8px;
  background: var(--theme-appPanelStrong);
  box-shadow: var(--theme-shadowPanel);
}

.session-filter-menu__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  font-size: 0.72rem;
  color: var(--theme-textMuted);
}

.session-filter-clear {
  color: var(--theme-accent);
}

.session-filter-option {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  padding: 0.35rem 0.25rem;
  font-size: 0.76rem;
  border-radius: 6px;
}

.session-filter-option:hover {
  background: var(--theme-appPanelMuted);
}

.task-swipe-row {
  position: relative;
  touch-action: pan-y;
}

.task-swipe-action {
  position: absolute;
  inset: 0 0 0 auto;
  width: 88px;
  display: flex;
  align-items: stretch;
  justify-content: flex-end;
  opacity: 0;
  transition: opacity 0.18s ease;
}

.task-swipe-action--visible {
  opacity: 1;
}

.task-swipe-delete {
  width: 88px;
  height: 100%;
  display: inline-flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.4rem;
  border-radius: 0 2px 2px 0;
  background: color-mix(in srgb, var(--theme-danger) 84%, var(--theme-appPanelStrong));
  color: white;
  font-size: 0.7rem;
  line-height: 1.2;
}

.workbench-task-card {
  will-change: transform;
}

.task-session-label {
  position: relative;
  overflow: hidden;
  font-size: 0.68rem;
  line-height: 1.1;
  border-width: 1px;
  border-style: solid;
  border-color: color-mix(in srgb, var(--task-project-accent, var(--theme-accent)) 36%, var(--theme-borderStrong));
  background:
    linear-gradient(
      135deg,
      color-mix(in srgb, var(--task-project-tint, transparent) 92%, var(--theme-appPanelStrong)) 0%,
      color-mix(in srgb, var(--task-project-tint, transparent) 64%, var(--theme-appPanel)) 100%
    );
  color: color-mix(in srgb, var(--task-project-accent, var(--theme-accent)) 68%, var(--theme-textPrimary));
  box-shadow:
    inset 0 1px 0 color-mix(in srgb, white 28%, transparent),
    inset 0 0 0 1px color-mix(in srgb, var(--task-project-accent, var(--theme-accent)) 10%, transparent);
  font-weight: 600;
  letter-spacing: 0.015em;
  border-radius: 0.4rem;
}

</style>
