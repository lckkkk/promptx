<script setup>
import { NodeViewContent, NodeViewWrapper, nodeViewProps } from '@tiptap/vue-3'

defineProps(nodeViewProps)
</script>

<template>
  <NodeViewWrapper data-promptx-node="text">
    <NodeViewContent
      data-promptx-node-content="text"
      class="min-h-[40px] whitespace-pre-wrap break-words border-0 bg-transparent p-0 text-[15px] leading-8 text-[var(--theme-textPrimary)] outline-none"
      as="div"
    />
  </NodeViewWrapper>
</template>
