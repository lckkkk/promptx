<script setup>
import { FolderOpen } from 'lucide-vue-next'

defineProps({
  busy: {
    type: Boolean,
    default: false,
  },
  canEditEngine: {
    type: Boolean,
    default: true,
  },
  canEditCwd: {
    type: Boolean,
    default: true,
  },
  cwd: {
    type: String,
    default: '',
  },
  cwdReadonlyMessage: {
    type: String,
    default: '',
  },
  duplicateCwdMessage: {
    type: String,
    default: '',
  },
  engine: {
    type: String,
    default: 'codex',
  },
  engineOptions: {
    type: Array,
    default: () => [],
  },
  engineReadonlyMessage: {
    type: String,
    default: '',
  },
  mobile: {
    type: Boolean,
    default: false,
  },
  title: {
    type: String,
    default: '',
  },
  workspaceSuggestions: {
    type: Array,
    default: () => [],
  },
})

const emit = defineEmits(['open-directory-picker', 'update:cwd', 'update:engine', 'update:title'])
</script>

<template>
  <div class="grid gap-4" :class="mobile ? '' : 'sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]'">
    <label class="theme-muted-text block text-xs">
      <span>项目标题（可选）</span>
      <input
        :value="title"
        type="text"
        maxlength="140"
        placeholder=""
        class="tool-input mt-1"
        :disabled="busy"
        @input="emit('update:title', $event.target.value)"
      >
    </label>

    <label class="theme-muted-text block text-xs">
      <span>执行引擎</span>
      <select
        :value="engine"
        class="tool-input mt-1"
        :disabled="busy || !canEditEngine"
        @change="emit('update:engine', $event.target.value)"
      >
        <option v-for="item in engineOptions" :key="item.value" :value="item.value" :disabled="item.enabled === false">
          {{ item.label }}{{ item.enabled === false ? '（即将支持）' : '' }}
        </option>
      </select>
      <p v-if="engineReadonlyMessage" class="theme-muted-text mt-2 text-[11px] leading-5">
        {{ engineReadonlyMessage }}
      </p>
    </label>

    <label class="theme-muted-text block text-xs">
      <span>工作目录</span>
      <div class="mt-1 flex gap-2">
        <input
          :value="cwd"
          type="text"
          list="codex-manager-workspace-suggestions"
          placeholder=""
          class="tool-input min-w-0 flex-1 disabled:cursor-not-allowed disabled:opacity-80"
          :class="duplicateCwdMessage ? 'border-[var(--theme-warning)]' : ''"
          :disabled="busy || !canEditCwd"
          @input="emit('update:cwd', $event.target.value)"
        >
        <button
          type="button"
          class="tool-button inline-flex shrink-0 items-center gap-2 px-3 py-2 text-xs"
          :disabled="busy || !canEditCwd"
          @click="emit('open-directory-picker')"
        >
          <FolderOpen class="h-4 w-4" />
          <span>{{ mobile ? '选择' : '选择目录' }}</span>
        </button>
      </div>
      <datalist id="codex-manager-workspace-suggestions">
        <option v-for="item in workspaceSuggestions" :key="item" :value="item" />
      </datalist>
      <p v-if="duplicateCwdMessage" class="mt-2 text-[11px] leading-5 text-[var(--theme-warningText)]">
        {{ duplicateCwdMessage }}
      </p>
      <p v-else-if="cwdReadonlyMessage" class="theme-muted-text mt-2 text-[11px] leading-5">
        {{ cwdReadonlyMessage }}
      </p>
    </label>
  </div>
</template>
