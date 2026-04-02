export function restoreTiptapNodeViewEditorFocus(editor) {
  const editorRoot = editor?.view?.dom
  if (!(editorRoot instanceof HTMLElement)) {
    return
  }

  const scrollContainer = editorRoot.closest('[data-promptx-editor-scroll="tiptap"]')
  const preservedScrollTop = scrollContainer instanceof HTMLElement ? scrollContainer.scrollTop : null
  const preservedScrollLeft = scrollContainer instanceof HTMLElement ? scrollContainer.scrollLeft : null

  const focus = () => {
    editorRoot.focus({ preventScroll: true })
    if (scrollContainer instanceof HTMLElement && preservedScrollTop !== null) {
      scrollContainer.scrollTop = preservedScrollTop
      scrollContainer.scrollLeft = preservedScrollLeft ?? 0
    }
  }

  if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
    window.requestAnimationFrame(focus)
    return
  }

  queueMicrotask(focus)
}
