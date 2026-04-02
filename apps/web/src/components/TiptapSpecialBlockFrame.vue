<script setup>
import { computed } from 'vue'

const props = defineProps({
  actionsAttributes: {
    type: Object,
    default: () => ({}),
  },
  actionsLayoutClass: {
    type: String,
    default: 'flex w-full shrink-0 items-center justify-start sm:w-auto sm:justify-end',
  },
  frameClass: {
    type: String,
    default: '',
  },
  headerClass: {
    type: String,
    default: '',
  },
  selected: {
    type: Boolean,
    default: false,
  },
})

const frameStateClass = computed(() => (
  props.selected
    ? 'ring-1 ring-inset ring-[var(--theme-borderStrong)]'
    : ''
))

const actionsStateClass = computed(() => (
  props.selected
    ? 'opacity-100'
    : 'opacity-100 sm:opacity-45 sm:group-hover:opacity-100 sm:focus-within:opacity-100'
))
</script>

<template>
  <div
    class="overflow-hidden rounded-sm transition"
    :class="[frameClass, frameStateClass]"
  >
    <div class="theme-divider border-b px-4 py-3 text-xs" :class="headerClass">
      <div class="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div class="min-w-0 flex-1">
          <slot name="meta" />
        </div>

        <div
          v-bind="actionsAttributes"
          class="transition"
          :class="[actionsLayoutClass, actionsStateClass]"
        >
          <slot name="actions" />
        </div>
      </div>
    </div>

    <slot />
  </div>
</template>
