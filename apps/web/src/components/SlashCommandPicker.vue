<script setup>
import { computed, ref, watch } from 'vue'
import { Command, CornerDownLeft, Slash, X } from 'lucide-vue-next'
import { getAgentEngineLabel } from '../lib/agentEngines.js'
import { searchAgentSlashCommands } from '../lib/agentSlashCommands.js'
import { useI18n } from '../composables/useI18n.js'

const props = defineProps({
  open: {
    type: Boolean,
    default: false,
  },
  query: {
    type: String,
    default: '',
  },
  agentEngine: {
    type: String,
    default: 'codex',
  },
  anchorRect: {
    type: Object,
    default: null,
  },
})

const emit = defineEmits(['close', 'select'])
const panelRef = ref(null)
const activeIndex = ref(0)
const { t } = useI18n()

const items = computed(() => searchAgentSlashCommands(props.agentEngine, props.query))
const panelStyle = computed(() => {
  const anchor = props.anchorRect
  if (!anchor) {
    return {
      left: '24px',
      top: '120px',
      width: 'min(440px, calc(100vw - 24px))',
    }
  }

  return {
    left: `${Math.max(12, Math.round(anchor.left))}px`,
    top: `${Math.round(anchor.bottom + 8)}px`,
    width: 'min(440px, calc(100vw - 24px))',
  }
})
const activeItem = computed(() => items.value[activeIndex.value] || null)

function closePicker() {
  emit('close')
}

function moveActive(step = 1) {
  if (!items.value.length) {
    return false
  }

  const size = items.value.length
  const nextIndex = (activeIndex.value + step + size) % size
  activeIndex.value = nextIndex
  return true
}

function confirmActive() {
  if (!activeItem.value) {
    return false
  }
  emit('select', activeItem.value)
  return true
}

watch(
  () => [props.open, props.query, props.agentEngine, items.value.length],
  () => {
    activeIndex.value = 0
  },
  { immediate: true }
)

defineExpose({
  moveActive,
  confirmActive,
})
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open && anchorRect"
      ref="panelRef"
      class="theme-popover fixed z-40 flex max-h-[22rem] flex-col overflow-hidden rounded-sm border shadow-lg"
      :style="panelStyle"
    >
      <div class="theme-divider flex items-center justify-between gap-2 border-b border-dashed px-3 py-2">
        <div class="min-w-0">
          <div class="flex items-center gap-2 text-xs font-medium text-[var(--theme-textPrimary)]">
            <Command class="h-3.5 w-3.5" />
            <span>{{ t('blockEditor.slashTitle') }}</span>
            <span class="theme-status-neutral inline-flex items-center rounded-sm border border-dashed px-1.5 py-0.5 text-[10px]">
              {{ getAgentEngineLabel(agentEngine) }}
            </span>
          </div>
          <p class="theme-muted-text mt-1 truncate text-[11px]">
            {{ t('blockEditor.slashHint') }}
          </p>
        </div>
        <button
          type="button"
          class="tool-button inline-flex h-7 w-7 items-center justify-center"
          @click="closePicker"
        >
          <X class="h-4 w-4" />
        </button>
      </div>

      <div class="min-h-0 flex-1 overflow-y-auto p-2">
        <div v-if="!items.length" class="theme-empty-state px-3 py-4 text-xs">
          {{ t('blockEditor.slashEmpty') }}
        </div>

        <button
          v-for="(item, index) in items"
          :key="item.command"
          type="button"
          class="flex w-full items-start gap-3 rounded-sm border border-transparent px-3 py-2 text-left transition"
          :class="index === activeIndex ? 'theme-list-item-active' : 'theme-list-item-hover'"
          @mouseenter="activeIndex = index"
          @click="emit('select', item)"
        >
          <span class="theme-status-neutral mt-0.5 inline-flex h-6 min-w-0 shrink-0 items-center rounded-sm border border-dashed px-1.5 text-[11px] font-medium">
            <Slash class="mr-1 h-3 w-3" />
            {{ item.command }}
          </span>
          <div class="min-w-0 flex-1">
            <div class="truncate text-[13px] text-[var(--theme-textPrimary)]">
              {{ item.description }}
            </div>
            <div v-if="item.aliases?.length" class="theme-muted-text mt-1 truncate text-[11px]">
              {{ t('blockEditor.slashAliases', { value: item.aliases.map((alias) => `/${alias}`).join(' · ') }) }}
            </div>
          </div>
          <span
            v-if="index === activeIndex"
            class="theme-muted-text inline-flex shrink-0 items-center gap-1 text-[10px]"
          >
            <CornerDownLeft class="h-3 w-3" />
            <span>Enter</span>
          </span>
        </button>
      </div>
    </div>
  </Teleport>
</template>
