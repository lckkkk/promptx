<script setup>
defineOptions({
  name: 'ProcessDetailRenderer',
})

import { computed, ref, watch } from 'vue'
import { Check } from 'lucide-vue-next'
import { renderCodexMarkdown } from '../lib/codexMarkdown.js'
import { useI18n } from '../composables/useI18n.js'
import { createProcessDetailBlockKeyEntries } from '../lib/processDetailBlockKeys.js'

const props = defineProps({
  blocks: {
    type: Array,
    default: () => [],
  },
  kind: {
    type: String,
    default: '',
  },
  detail: {
    type: String,
    default: '',
  },
})

const { t } = useI18n()
const expandedSubAgentMessageKeys = ref(new Set())

const normalizedBlocks = computed(() => {
  const blocks = Array.isArray(props.blocks) ? props.blocks.filter(Boolean) : []
  if (blocks.length) {
    return blocks
  }

  if (String(props.detail || '').trim()) {
    return [{ type: 'text', text: String(props.detail || '').trim() }]
  }

  return []
})

const blockKeyEntries = computed(() => createProcessDetailBlockKeyEntries(normalizedBlocks.value))
const blockKeys = computed(() => blockKeyEntries.value.map((entry) => entry.key))

watch(normalizedBlocks, (nextBlocks = []) => {
  const availableKeys = new Set()
  nextBlocks.forEach((block, blockIndex) => {
    if (block?.type !== 'sub_agent_list') {
      return
    }

    ;(Array.isArray(block.items) ? block.items : []).forEach((item, itemIndex) => {
      availableKeys.add(getSubAgentMessageKey(blockIndex, item, itemIndex))
    })
  })

  expandedSubAgentMessageKeys.value = new Set(
    [...expandedSubAgentMessageKeys.value].filter((key) => availableKeys.has(key))
  )
}, { immediate: true })

function renderMarkdown(text = '') {
  return renderCodexMarkdown(String(text || ''))
}

function formatChangeKind(kind = '') {
  const normalized = String(kind || '').trim()
  if (normalized === 'create') {
    return t('processDetail.changeCreate')
  }
  if (normalized === 'delete') {
    return t('processDetail.changeDelete')
  }
  if (normalized === 'update') {
    return t('processDetail.changeUpdate')
  }
  return t('processDetail.changeGeneric')
}

function isLongMetaValue(item = {}) {
  const label = String(item?.label || '').trim().toLowerCase()
  const value = String(item?.value || '').trim()
  if (!value) {
    return false
  }

  if (value.length > 56) {
    return true
  }

  if (['命令', 'command', '目标', 'target', 'url', '路径', 'path'].includes(label) && value.length > 28) {
    return true
  }

  return value.includes(' ') && value.length > 36
}

function shouldHideMetaLabel(item = {}, items = []) {
  const label = String(item?.label || '').trim().toLowerCase()
  if (!['命令', 'command'].includes(label)) {
    return false
  }

  return Array.isArray(items) && items.length === 1
}

function shouldUseMonoMetaValue(item = {}) {
  const label = String(item?.label || '').trim().toLowerCase()
  return ['命令', 'command', '路径', 'path', 'url', '目标', 'target'].includes(label)
}

function getChecklistItemStatus(item = {}) {
  if (item?.completed) {
    return 'completed'
  }

  const status = String(item?.status || '').trim().toLowerCase()
  if (status === 'in_progress') {
    return 'in_progress'
  }

  return 'pending'
}

function formatHiddenItems(count = 0) {
  return t('processDetail.hiddenItems', { count })
}

function formatDirectorySummary(count = 0) {
  return t('processDetail.directorySummary', { count })
}

function formatDirectoryHidden(count = 0) {
  return t('processDetail.directoryHidden', { count })
}

function getBlockKey(blockIndex = 0) {
  return blockKeys.value[blockIndex] || `block-${blockIndex}`
}

function formatSubAgentStatus(status = '') {
  const normalized = String(status || '').trim().toLowerCase()
  if (normalized === 'completed') {
    return t('processDetail.subAgentCompleted')
  }
  if (normalized === 'failed') {
    return t('processDetail.subAgentFailed')
  }
  if (normalized === 'running') {
    return t('processDetail.subAgentRunning')
  }
  if (normalized === 'pending_init') {
    return t('processDetail.subAgentPending')
  }
  return t('processDetail.subAgentUnknown')
}

function getSubAgentDisplayTitle(item = {}) {
  return String(item?.title || item?.target || item?.id || '').trim()
}

function getSubAgentMetaSummary(item = {}) {
  const title = getSubAgentDisplayTitle(item)
  const parts = []
  const role = String(item?.role || '').trim()
  const target = String(item?.target || '').trim()
  const model = String(item?.model || '').trim()

  if (role && role.toLowerCase() !== 'default') {
    parts.push(role)
  }
  if (target && target !== title) {
    parts.push(target)
  }
  if (model) {
    parts.push(model)
  }

  return parts.join(' · ')
}

function hasSubAgentMessage(item = {}) {
  return Boolean(String(item?.message || '').trim())
}

function getSubAgentInlinePreview(item = {}) {
  const message = String(item?.message || '').replace(/\s+/g, ' ').trim()
  if (message) {
    return message
  }

  return getSubAgentMetaSummary(item)
}

function getSubAgentMessageKey(blockIndex = 0, item = {}, itemIndex = 0) {
  return `${getBlockKey(blockIndex)}:sub-agent:${String(item?.id || item?.target || item?.title || itemIndex)}`
}

function isSubAgentMessageExpanded(blockIndex = 0, item = {}, itemIndex = 0) {
  return expandedSubAgentMessageKeys.value.has(getSubAgentMessageKey(blockIndex, item, itemIndex))
}

function toggleSubAgentMessage(blockIndex = 0, item = {}, itemIndex = 0) {
  const key = getSubAgentMessageKey(blockIndex, item, itemIndex)
  const next = new Set(expandedSubAgentMessageKeys.value)
  if (next.has(key)) {
    next.delete(key)
  } else {
    next.add(key)
  }
  expandedSubAgentMessageKeys.value = next
}

function getSubAgentMessageBlocks(item = {}) {
  return Array.isArray(item?.messageBlocks) ? item.messageBlocks.filter(Boolean) : []
}

function hasStructuredSubAgentMessage(item = {}) {
  const blocks = getSubAgentMessageBlocks(item)
  return blocks.some((block) => !['text', 'markdown'].includes(String(block?.type || '').trim()))
}
</script>

<template>
  <div v-if="normalizedBlocks.length" class="process-detail space-y-2">
    <template v-for="(block, blockIndex) in normalizedBlocks" :key="blockKeys[blockIndex] || `${block.type}-${blockIndex}`">
      <div v-if="block.type === 'meta'" class="process-detail-meta">
        <div
          v-for="(item, itemIndex) in block.items || []"
          :key="`${blockIndex}-meta-${itemIndex}`"
          class="process-detail-meta__item"
          :class="{
            'process-detail-meta__item--long': isLongMetaValue(item),
            'process-detail-meta__item--value-only': shouldHideMetaLabel(item, block.items),
          }"
        >
          <span v-if="!shouldHideMetaLabel(item, block.items)" class="process-detail-meta__label">{{ item.label }}</span>
          <span
            class="process-detail-meta__value"
            :class="{
              'process-detail-mobile-code-scroll': isLongMetaValue(item),
              'process-detail-meta__value--mono': shouldUseMonoMetaValue(item),
            }"
          >
            {{ item.value }}
          </span>
        </div>
      </div>

      <div v-else-if="block.type === 'checklist'" class="process-detail-panel">
        <div class="space-y-1.5">
          <div
            v-for="(item, itemIndex) in block.items || []"
            :key="`${blockIndex}-check-${itemIndex}`"
            class="process-detail-checklist__item"
          >
            <span
              class="process-detail-checklist__icon"
              :class="`is-${getChecklistItemStatus(item)}`"
            >
              <Check v-if="getChecklistItemStatus(item) === 'completed'" class="h-3 w-3" />
              <span v-else-if="getChecklistItemStatus(item) === 'in_progress'" class="process-detail-checklist__dot" />
            </span>
            <span :class="getChecklistItemStatus(item) === 'completed' ? 'line-through opacity-65' : ''">{{ item.text }}</span>
          </div>
        </div>
        <div v-if="block.totalCount" class="process-detail-footnote">
          {{ `已完成 ${(block.items || []).filter((item) => item.completed).length} / ${block.totalCount}` }}
          <span v-if="block.hiddenCount">{{ `，还有 ${block.hiddenCount} 项` }}</span>
        </div>
      </div>

      <div v-else-if="block.type === 'directory_list'" class="process-detail-panel">
        <div class="process-detail-directory__heading">
          <span v-if="block.path" class="font-medium">{{ block.path }}</span>
          <span v-if="block.entryType" class="process-detail-directory__type">{{ block.entryType }}</span>
        </div>
        <div class="process-detail-directory__list">
          <div
            v-for="(entry, entryIndex) in block.entries || []"
            :key="`${blockIndex}-entry-${entryIndex}`"
            class="process-detail-directory__item"
          >
            {{ entry }}
          </div>
        </div>
        <div v-if="block.totalCount" class="process-detail-footnote">
          {{ formatDirectorySummary(block.totalCount) }}
          <span v-if="block.hiddenCount">{{ formatDirectoryHidden(block.hiddenCount) }}</span>
        </div>
      </div>

      <div v-else-if="block.type === 'bullet_list'" class="process-detail-panel">
        <ul class="list-disc space-y-1.5 pl-5">
          <li v-for="(item, itemIndex) in block.items || []" :key="`${blockIndex}-bullet-${itemIndex}`">{{ item }}</li>
        </ul>
        <div v-if="block.hiddenCount" class="process-detail-footnote">{{ formatHiddenItems(block.hiddenCount) }}</div>
      </div>

      <div v-else-if="block.type === 'file_changes'" class="process-detail-panel">
        <div class="space-y-1.5">
          <div
            v-for="(item, itemIndex) in block.items || []"
            :key="`${blockIndex}-change-${itemIndex}`"
            class="process-detail-filechange__item"
          >
            <span class="process-detail-filechange__kind">{{ formatChangeKind(item.kind) }}</span>
            <span class="process-detail-filechange__path process-detail-mobile-code-scroll">{{ item.path }}</span>
          </div>
        </div>
      </div>

      <div v-else-if="block.type === 'sub_agent_list'" class="process-detail-panel">
        <div class="space-y-2">
          <div
            v-for="(item, itemIndex) in block.items || []"
            :key="`${blockIndex}-sub-agent-${itemIndex}`"
            class="min-w-0"
          >
            <div class="flex min-w-0 items-center gap-2 text-xs leading-5">
              <div class="min-w-0 flex flex-1 items-center gap-2">
                <span class="shrink-0 font-medium text-[var(--theme-textPrimary)]">
                  {{ getSubAgentDisplayTitle(item) }}
                </span>
                <span
                  v-if="getSubAgentInlinePreview(item)"
                  class="process-detail-subagent__preview theme-muted-text min-w-0 flex-1"
                  :title="getSubAgentInlinePreview(item)"
                >
                  {{ getSubAgentInlinePreview(item) }}
                </span>
              </div>
              <button
                v-if="hasSubAgentMessage(item)"
                type="button"
                class="theme-muted-text shrink-0 text-[11px] underline decoration-dashed underline-offset-2"
                @click="toggleSubAgentMessage(blockIndex, item, itemIndex)"
              >
                {{ isSubAgentMessageExpanded(blockIndex, item, itemIndex) ? t('common.collapse') : t('common.expand') }}
              </button>
              <span class="process-detail-directory__type shrink-0">
                {{ formatSubAgentStatus(item.status) }}
              </span>
            </div>
            <div
              v-if="hasSubAgentMessage(item) && isSubAgentMessageExpanded(blockIndex, item, itemIndex)"
              class="mt-2 border-l border-dashed border-[color:color-mix(in_srgb,currentColor_14%,transparent)] pl-3"
            >
              <ProcessDetailRenderer
                v-if="hasStructuredSubAgentMessage(item)"
                :blocks="getSubAgentMessageBlocks(item)"
                kind="sub-agent-message"
              />
              <pre
                v-else
                class="theme-muted-text whitespace-pre-wrap break-words text-xs leading-5"
              >{{ item.message }}</pre>
            </div>
          </div>
        </div>
      </div>

      <div
        v-else-if="block.type === 'markdown'"
        class="codex-markdown process-detail-markdown"
        :class="{ 'process-detail-markdown--reasoning': props.kind === 'reasoning' }"
        v-html="renderMarkdown(block.text)"
      />

      <pre v-else class="process-detail-text">{{ block.text }}</pre>
    </template>
  </div>
</template>
