<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ChevronDown, LoaderCircle } from 'lucide-vue-next'
import { useI18n } from '../composables/useI18n.js'

const props = defineProps({
  modelValue: {
    type: [String, Number],
    default: '',
  },
  options: {
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
  placeholder: {
    type: String,
    default: '',
  },
  emptyText: {
    type: String,
    default: '',
  },
  getOptionValue: {
    type: Function,
    default: (option) => option?.id ?? option?.value ?? '',
  },
})

const emit = defineEmits(['update:modelValue', 'refresh-intent'])
const { t } = useI18n()

const rootRef = ref(null)
const panelRef = ref(null)
const open = ref(false)
const openUpward = ref(false)
const panelStyle = ref({})

const selectedOption = computed(() => {
  const currentValue = String(props.modelValue ?? '')
  return props.options.find((option) => String(props.getOptionValue(option) ?? '') === currentValue) || null
})
const resolvedPlaceholder = computed(() => props.placeholder || t('common.select'))
const resolvedEmptyText = computed(() => props.emptyText || t('common.noOptions'))

function getOptionLabel(option) {
  if (option && typeof option === 'object' && Object.prototype.hasOwnProperty.call(option, 'label')) {
    return String(option.label || '')
  }

  return String(props.getOptionValue(option) ?? '')
}

function openDropdown() {
  if (props.disabled) {
    return
  }

  if (!open.value) {
    emit('refresh-intent')
  }
  open.value = true
}

function closeDropdown() {
  open.value = false
}

function toggleDropdown() {
  if (open.value) {
    closeDropdown()
    return
  }

  openDropdown()
}

function selectOption(option) {
  emit('update:modelValue', String(props.getOptionValue(option) ?? '').trim())
  closeDropdown()
}

function updatePanelPosition() {
  if (!open.value || !rootRef.value || typeof window === 'undefined') {
    return
  }

  const rect = rootRef.value.getBoundingClientRect()
  const viewportWidth = window.innerWidth
  const viewportHeight = window.innerHeight
  const gap = 8
  const edgePadding = 8
  const minPanelHeight = 160
  const preferredPanelHeight = 360
  const spaceBelow = Math.max(0, viewportHeight - rect.bottom - edgePadding)
  const spaceAbove = Math.max(0, rect.top - edgePadding)

  openUpward.value = spaceBelow < 260 && spaceAbove > spaceBelow

  const availableHeight = openUpward.value ? spaceAbove - gap : spaceBelow - gap
  const maxHeight = Math.max(
    Math.min(preferredPanelHeight, Math.max(availableHeight, 0)),
    Math.min(minPanelHeight, openUpward.value ? spaceAbove : spaceBelow)
  )

  const width = Math.min(rect.width, viewportWidth - edgePadding * 2)
  const left = Math.min(
    Math.max(edgePadding, rect.left),
    Math.max(edgePadding, viewportWidth - edgePadding - width)
  )

  panelStyle.value = {
    left: `${left}px`,
    top: openUpward.value ? `${rect.top - gap}px` : `${rect.bottom + gap}px`,
    width: `${width}px`,
    maxHeight: `${Math.max(maxHeight, 120)}px`,
    transform: openUpward.value ? 'translateY(-100%)' : 'none',
  }
}

function handleDocumentPointerDown(event) {
  if (!open.value || !rootRef.value) {
    return
  }

  if (rootRef.value.contains(event.target) || panelRef.value?.contains(event.target)) {
    return
  }

  closeDropdown()
}

function handleDocumentKeydown(event) {
  if (event.key === 'Escape') {
    closeDropdown()
  }
}

watch(
  () => props.disabled,
  (disabled) => {
    if (disabled) {
      closeDropdown()
    }
  }
)

watch(open, async (value) => {
  if (!value) {
    return
  }

  await nextTick()
  updatePanelPosition()
})

onMounted(() => {
  document.addEventListener('pointerdown', handleDocumentPointerDown)
  document.addEventListener('keydown', handleDocumentKeydown)
  window.addEventListener('resize', updatePanelPosition)
  window.addEventListener('scroll', updatePanelPosition, true)
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', handleDocumentPointerDown)
  document.removeEventListener('keydown', handleDocumentKeydown)
  window.removeEventListener('resize', updatePanelPosition)
  window.removeEventListener('scroll', updatePanelPosition, true)
})
</script>

<template>
  <div ref="rootRef" class="relative min-w-0">
    <button
      type="button"
      class="workbench-select-trigger flex w-full items-center gap-3 rounded-sm border px-3 py-2 text-left transition focus:outline-none focus:ring-2"
      :class="disabled
        ? 'cursor-not-allowed border-[color-mix(in_srgb,var(--theme-borderDefault)_88%,var(--theme-textMuted))] bg-[color-mix(in_srgb,var(--theme-appPanelMuted)_82%,var(--theme-appBg))] text-[var(--theme-textMuted)]'
        : 'theme-input-shell text-[var(--theme-textPrimary)] hover:border-[var(--theme-borderStrong)] focus:border-[var(--theme-borderStrong)] focus:ring-[var(--theme-focusRing)]'"
      :disabled="disabled"
      @click="toggleDropdown"
      @keydown.down.prevent="openDropdown"
      @keydown.enter.prevent="toggleDropdown"
      @keydown.space.prevent="toggleDropdown"
    >
      <div class="min-w-0 flex-1">
        <slot
          name="trigger"
          :selected-option="selectedOption"
          :open="open"
          :loading="loading"
          :disabled="disabled"
        >
          <div class="theme-muted-text text-sm">
            {{ selectedOption ? getOptionLabel(selectedOption) : resolvedPlaceholder }}
          </div>
        </slot>
      </div>

      <div class="flex shrink-0 items-center gap-2" :class="disabled ? 'text-[var(--theme-textMuted)] opacity-80' : 'theme-muted-text'">
        <LoaderCircle v-if="loading" class="h-4 w-4 animate-spin" />
        <ChevronDown class="h-4 w-4 transition" :class="open ? 'rotate-180' : ''" />
      </div>
    </button>

    <Teleport to="body">
      <div
        v-if="open"
        ref="panelRef"
        class="workbench-select-panel theme-popover fixed z-[90] flex overflow-hidden rounded-sm border"
        :style="panelStyle"
      >
        <div class="flex min-h-0 w-full flex-col">
          <slot
            name="header"
            :loading="loading"
            :options="options"
          />

          <div class="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
            <template v-if="options.length">
              <slot
                v-for="option in options"
                :key="String(getOptionValue(option) ?? '')"
                name="option"
                :option="option"
                :selected="String(getOptionValue(option) ?? '') === String(modelValue ?? '')"
                :select="() => selectOption(option)"
              >
                <button
                  type="button"
                  class="workbench-select-option theme-filter-idle w-full rounded-sm border border-dashed px-3 py-2 text-left text-sm"
                  @click="selectOption(option)"
                >
                  {{ getOptionLabel(option) }}
                </button>
              </slot>
            </template>

            <slot
              v-else
              name="empty"
            >
              <div class="theme-empty-state px-3 py-4 text-sm">
                {{ resolvedEmptyText }}
              </div>
            </slot>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>
