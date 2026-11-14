export function navigate(path) {
  window.history.pushState({}, '', path)
  window.dispatchEvent(new Event('app:navigate'))
  window.scrollTo({ top: 0, behavior: 'smooth' })
}

export function AppLink({ href, onNavigate, className = '', children, ...props }) {
  return (
    <a
      href={href}
      className={className}
      onClick={(event) => {
        if (
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        ) {
          return
        }
        event.preventDefault()
        navigate(href)
        onNavigate?.()
      }}
      {...props}
    >
      {children}
    </a>
  )
}
