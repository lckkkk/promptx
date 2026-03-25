<script setup>
import { computed } from 'vue'
import { Check } from 'lucide-vue-next'
import { useI18n } from '../composables/useI18n.js'
import { useTheme } from '../composables/useTheme.js'

const { currentTheme, setTheme, themes } = useTheme()
const { t } = useI18n()

const themeGroups = computed(() => {
  const light = themes.value.filter((theme) => theme.mode === 'light')
  const dark = themes.value.filter((theme) => theme.mode === 'dark')
  return [
    { id: 'light', label: t('theme.groupLight'), items: light },
    { id: 'dark', label: t('theme.groupDark'), items: dark },
  ].filter((group) => group.items.length)
})

function handleThemeSelect(themeId) {
  setTheme(themeId)
}

function getThemeDescription(theme) {
  return t(`theme.description.${theme.id}`, {}, theme.description)
}
</script>

<template>
  <div class="space-y-4">
    <div>
      <div class="flex items-center justify-between gap-3">
        <div class="theme-heading text-sm font-medium">{{ t('theme.heading') }}</div>
        <div class="theme-toggle-current theme-badge-muted theme-muted-text rounded-sm border border-dashed px-2 py-1 text-[11px]">
          {{ t('theme.currentTheme', { name: currentTheme.shortName }) }}
        </div>
      </div>
      <div class="theme-muted-text theme-note-text mt-1">{{ t('theme.helper') }}</div>
    </div>

    <div class="space-y-4">
      <section v-for="group in themeGroups" :key="group.id" class="space-y-1.5">
        <div class="theme-muted-text px-1 text-[10px] font-medium uppercase tracking-[0.16em]">{{ group.label }}</div>
        <button
          v-for="theme in group.items"
          :key="theme.id"
          type="button"
          class="theme-option theme-toggle-card w-full rounded-sm border px-3 py-2 text-left transition"
          :class="theme.id === currentTheme.id ? 'theme-option-active' : 'theme-option-idle'"
          @click="handleThemeSelect(theme.id)"
        >
          <div class="flex items-start gap-3">
            <div class="mt-0.5 flex items-center gap-1.5">
              <span
                v-for="(swatch, index) in theme.swatches"
                :key="`${theme.id}-${index}`"
                class="h-3 w-3 rounded-full border border-black/10"
                :style="{ backgroundColor: swatch }"
              />
            </div>
            <div class="min-w-0 flex-1">
              <div class="flex items-center justify-between gap-2">
                <span class="truncate text-sm font-medium">{{ theme.shortName }}</span>
                <Check v-if="theme.id === currentTheme.id" class="h-4 w-4 shrink-0" />
              </div>
              <div class="theme-muted-text theme-note-text mt-1">{{ getThemeDescription(theme) }}</div>
            </div>
          </div>
        </button>
      </section>
    </div>
  </div>
</template>
