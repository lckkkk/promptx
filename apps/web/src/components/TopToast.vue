<script setup>
import { CheckCircle2, CircleAlert, CircleX, Info } from 'lucide-vue-next'

const props = defineProps({
  message: {
    type: String,
    default: '',
  },
  type: {
    type: String,
    default: 'success',
  },
})

function getToastClass(type = 'success') {
  if (type === 'warning') {
    return 'theme-status-warning'
  }
  if (type === 'error') {
    return 'theme-status-danger'
  }
  if (type === 'info') {
    return 'theme-status-info'
  }
  return 'theme-status-success'
}

function getToastIcon(type = 'success') {
  if (type === 'warning') {
    return CircleAlert
  }
  if (type === 'error') {
    return CircleX
  }
  if (type === 'info') {
    return Info
  }
  return CheckCircle2
}
</script>

<template>
  <Teleport to="body">
    <div class="pointer-events-none fixed inset-x-0 top-4 z-40 flex justify-center px-4">
      <Transition
        enter-active-class="transform transition duration-200 ease-out"
        enter-from-class="-translate-y-3 opacity-0"
        enter-to-class="translate-y-0 opacity-100"
        leave-active-class="transform transition duration-150 ease-in"
        leave-from-class="translate-y-0 opacity-100"
        leave-to-class="-translate-y-2 opacity-0"
      >
        <div
          v-if="message"
          class="app-top-toast flex max-w-md items-center gap-2 rounded-sm border px-4 py-2 text-sm shadow-[var(--theme-shadowPanel)] backdrop-blur"
          :class="getToastClass(props.type)"
        >
          <component :is="getToastIcon(props.type)" class="h-4 w-4 shrink-0" />
          <span>{{ message }}</span>
        </div>
      </Transition>
    </div>
  </Teleport>
</template>
