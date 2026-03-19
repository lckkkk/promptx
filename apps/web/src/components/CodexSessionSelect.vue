<script setup>
import { Check, LoaderCircle } from 'lucide-vue-next'
import WorkbenchSelect from './WorkbenchSelect.vue'

const props = defineProps({
  modelValue: {
    type: String,
    default: '',
  },
  sessions: {
    type: Array,
    default: () => [],
  },
  loading: {
    type: Boolean,
    default: false,
  },
  disabled: {
    type: Boolean,
    default: false,
  },
})

const emit = defineEmits(['update:modelValue', 'refresh-intent'])

function getSessionTitle(session) {
  return session?.title || '未命名项目'
}

function getSessionCwd(session) {
  return session?.cwd || '未设置路径'
}

function getRuntimeStatusLabel(session) {
  return session?.running ? '运行中' : '空闲'
}

function getRuntimeStatusClass(session) {
  return session?.running ? 'theme-status-warning' : 'theme-status-success'
}

function getOptionClass(selected) {
  return selected ? 'theme-filter-active' : 'theme-filter-idle'
}
</script>

<template>
  <WorkbenchSelect
    :model-value="modelValue"
    :options="sessions"
    :loading="loading"
    :disabled="disabled"
    placeholder="请选择项目"
    empty-text="还没有项目，请先到管理弹窗里新建。"
    :get-option-value="(session) => session?.id || ''"
    @update:model-value="emit('update:modelValue', $event)"
    @refresh-intent="emit('refresh-intent')"
  >
    <template #trigger="{ selectedOption }">
      <template v-if="selectedOption">
        <div class="flex items-center gap-2 text-sm">
          <span class="min-w-0 flex-1 truncate">
            <span class="font-medium text-[var(--theme-textPrimary)]">{{ getSessionTitle(selectedOption) }}</span>
            <span class="theme-muted-text ml-2 font-mono text-[11px]">{{ getSessionCwd(selectedOption) }}</span>
          </span>
          <span class="inline-flex items-center rounded-sm border border-dashed px-1.5 py-0.5 text-[10px]" :class="getRuntimeStatusClass(selectedOption)">
            {{ getRuntimeStatusLabel(selectedOption) }}
          </span>
        </div>
      </template>
      <template v-else>
        <div class="theme-muted-text text-sm">
          {{ loading ? '正在同步项目...' : '请选择项目' }}
        </div>
      </template>
    </template>

    <template #header>
      <div class="theme-divider theme-muted-text flex items-center justify-between gap-3 border-b border-dashed px-3 py-2 text-[11px]">
        <span>{{ loading ? '正在同步最新项目...' : `共 ${sessions.length} 个项目` }}</span>
        <LoaderCircle v-if="loading" class="h-3.5 w-3.5 animate-spin" />
      </div>
    </template>

    <template #option="{ option, selected, select }">
      <button
        type="button"
        class="w-full rounded-sm border border-dashed p-3 text-left transition"
        :class="getOptionClass(selected)"
        @click="select"
      >
        <div class="flex items-start gap-3">
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2 text-sm">
              <span class="min-w-0 flex-1 truncate">
                <span class="font-medium text-[var(--theme-textPrimary)]">{{ getSessionTitle(option) }}</span>
                <span class="theme-muted-text ml-2 font-mono text-[11px]">{{ getSessionCwd(option) }}</span>
              </span>
              <span class="inline-flex items-center rounded-sm border border-dashed px-1.5 py-0.5 text-[10px]" :class="getRuntimeStatusClass(option)">
                {{ getRuntimeStatusLabel(option) }}
              </span>
            </div>
          </div>

          <Check
            v-if="selected"
            class="mt-0.5 h-4 w-4 shrink-0 text-[var(--theme-textSecondary)]"
          />
        </div>
      </button>
    </template>
  </WorkbenchSelect>
</template>
