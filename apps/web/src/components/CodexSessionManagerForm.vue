<script setup>
import { Check, Copy, FolderOpen } from 'lucide-vue-next'
import { computed } from 'vue'
import { useI18n } from '../composables/useI18n.js'
import WorkbenchSelect from './WorkbenchSelect.vue'

const props = defineProps({
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
  canEditSessionId: {
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
  sessionId: {
    type: String,
    default: '',
  },
  sessionIdCopied: {
    type: Boolean,
    default: false,
  },
  sessionIdReadonlyMessage: {
    type: String,
    default: '',
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

const emit = defineEmits(['copy-session-id', 'open-directory-picker', 'update:cwd', 'update:engine', 'update:sessionId', 'update:title'])
const { t } = useI18n()
const selectedEngineOption = computed(() => {
  const current = String(props.engine || '').trim()
  return props.engineOptions.find((item) => String(item?.value || '').trim() === current) || null
})
const normalizedSessionId = computed(() => String(props.sessionId || '').trim())
</script>

<template>
  <div class="grid gap-4">
    <label class="theme-muted-text block text-xs">
      <span>{{ t('projectManager.projectTitleOptional') }}</span>
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
      <span>{{ t('projectManager.workingDirectoryField') }}</span>
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
          <span>{{ mobile ? t('projectManager.choose') : t('projectManager.chooseDirectory') }}</span>
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

    <label class="theme-muted-text block text-xs">
      <span>{{ t('projectManager.engineField') }}</span>
      <div class="mt-1">
        <WorkbenchSelect
          :model-value="engine"
          :options="engineOptions"
          :disabled="busy || !canEditEngine"
          :placeholder="t('projectManager.selectEngine')"
          :empty-text="t('projectManager.noEngines')"
          :get-option-value="(item) => item?.value || ''"
          @update:model-value="emit('update:engine', $event)"
        >
          <template #trigger="{ disabled }">
            <div class="flex items-center gap-2 text-sm">
              <span
                class="min-w-0 flex-1 truncate"
                :class="disabled ? 'theme-muted-text' : 'text-[var(--theme-textPrimary)]'"
              >
                {{ selectedEngineOption?.label || t('projectManager.selectEngine') }}
              </span>
              <span
                v-if="selectedEngineOption && selectedEngineOption.enabled === false"
                class="theme-muted-text rounded-sm border border-dashed px-1.5 py-0.5 text-[10px]"
              >
                {{ t('projectManager.comingSoon') }}
              </span>
            </div>
          </template>

          <template #option="{ option, selected, select }">
            <button
              type="button"
              class="w-full rounded-sm border border-dashed px-3 py-2 text-left text-sm transition"
              :class="selected ? 'theme-filter-active' : 'theme-filter-idle'"
              :disabled="option?.enabled === false"
              @click="select"
            >
              <div class="flex items-center justify-between gap-3">
                <span class="min-w-0 flex-1 truncate">{{ option.label }}</span>
                <span
                  v-if="option?.enabled === false"
                  class="theme-muted-text rounded-sm border border-dashed px-1.5 py-0.5 text-[10px]"
                >
                  {{ t('projectManager.comingSoon') }}
                </span>
              </div>
            </button>
          </template>
        </WorkbenchSelect>
      </div>
      <p v-if="engineReadonlyMessage" class="theme-muted-text mt-2 text-[11px] leading-5">
        {{ engineReadonlyMessage }}
      </p>
    </label>

    <label class="theme-muted-text block text-xs">
      <span>{{ t('projectManager.sessionId') }}</span>
      <div class="mt-1 flex gap-2">
        <input
          :value="sessionId"
          type="text"
          placeholder=""
          class="tool-input min-w-0 flex-1 disabled:cursor-not-allowed disabled:opacity-80"
          :disabled="busy || !canEditSessionId"
          @input="emit('update:sessionId', $event.target.value)"
        >
        <button
          v-if="normalizedSessionId"
          type="button"
          class="tool-button inline-flex shrink-0 items-center gap-2 px-3 py-2 text-xs"
          :disabled="busy"
          @click="emit('copy-session-id')"
        >
          <Check v-if="sessionIdCopied" class="h-4 w-4" />
          <Copy v-else class="h-4 w-4" />
          <span>{{ sessionIdCopied ? t('projectManager.sessionIdCopied') : t('projectManager.copySessionId') }}</span>
        </button>
      </div>
      <p v-if="sessionIdReadonlyMessage" class="theme-muted-text mt-2 text-[11px] leading-5">
        {{ sessionIdReadonlyMessage }}
      </p>
      <p v-else class="theme-muted-text mt-2 text-[11px] leading-5">
        {{ t('projectManager.sessionIdHint') }}
      </p>
    </label>
  </div>
</template>
