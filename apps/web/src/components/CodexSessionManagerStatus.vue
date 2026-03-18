<script setup>
import { Info } from 'lucide-vue-next'

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
</script>

<template>
  <div class="space-y-3">
    <div class="dashed-panel px-3 py-3">
      <div class="theme-muted-text text-[11px]">运行状态</div>
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
          当前项目
        </span>
      </div>
    </div>

    <div class="dashed-panel px-3 py-3">
      <div class="theme-muted-text text-[11px]">工作目录</div>
      <div class="mt-2 break-all font-mono text-xs leading-6 text-[var(--theme-textPrimary)]">
        {{ activeSession?.cwd || '未设置' }}
      </div>
    </div>

    <div class="dashed-panel px-3 py-3">
      <div class="theme-muted-text text-[11px]">最近更新</div>
      <div class="mt-2 text-sm text-[var(--theme-textPrimary)]">
        {{ formatUpdatedAt(activeSession?.updatedAt) }}
      </div>
    </div>

    <div class="dashed-panel px-3 py-3">
      <div class="theme-muted-text inline-flex items-center gap-2 text-[11px]">
        <Info class="h-3.5 w-3.5" />
        <span>说明</span>
      </div>
      <p class="mt-2 text-xs leading-6 text-[var(--theme-textSecondary)]">
        项目绑定目录，目录不变时会继续复用同一个 Codex 线程。
      </p>
    </div>
  </div>
</template>
