const parseViewport = str => str
    ?.split(/[,;\s]/) // NOTE: technically, only the comma is valid
    ?.filter(x => x)
    ?.map(x => x.split('=').map(x => x.trim()))

const getViewport = (doc, viewport) => {
    // use `viewBox` for SVG
    if (doc.documentElement.localName === 'svg') {
        const [, , width, height] = doc.documentElement
            .getAttribute('viewBox')?.split(/\s/) ?? []
        return { width, height }
    }

    // get `viewport` `meta` element
    const meta = parseViewport(doc.querySelector('meta[name="viewport"]')
        ?.getAttribute('content'))
    if (meta) return Object.fromEntries(meta)

    // fallback to book's viewport
    if (typeof viewport === 'string') return parseViewport(viewport)
    if (viewport?.width && viewport.height) return viewport

    // if no viewport (possibly with image directly in spine), get image size
    const img = doc.querySelector('img')
    if (img) return { width: img.naturalWidth, height: img.naturalHeight }

    // just show *something*, i guess...
    console.warn(new Error('Missing viewport properties'))
    return { width: 1000, height: 2000 }
}

export class FixedLayout extends HTMLElement {
    static observedAttributes = ['zoom']
    #root = this.attachShadow({ mode: 'closed' })
    #observer = new ResizeObserver(() => this.#render())
    #spreads
    #index = -1
    defaultViewport
    spread
    #portrait = false
    #left
    #right
    #center
    #side
    #zoom
    // (Simply Reader patch) spreads are prepared before they're shown: their pages are loaded and
    // drawn while the old pages stay on screen (no blank page during a turn), and the next spread
    // is prepared in advance, so turning to it is immediate. Only the spread shown and the next
    // one are kept.
    #frames = new Map() // spread index -> { left, right } or { center }, plus `ready`
    #gen = 0
    #prepareTimer
    constructor() {
        super()

        const sheet = new CSSStyleSheet()
        this.#root.adoptedStyleSheets = [sheet]
        sheet.replaceSync(`:host {
            width: 100%;
            height: 100%;
            display: flex;
            justify-content: center;
            align-items: center;
            overflow: auto;
        }`)

        this.#observer.observe(this)
    }
    attributeChangedCallback(name, _, value) {
        switch (name) {
            case 'zoom':
                this.#zoom = value !== 'fit-width' && value !== 'fit-page'
                    ? parseFloat(value) : value
                this.#render()
                break
        }
    }
    async #createFrame({ index, src: srcOption }) {
        const srcOptionIsString = typeof srcOption === 'string'
        const src = srcOptionIsString ? srcOption : srcOption?.src
        const onZoom = srcOptionIsString ? null : srcOption?.onZoom
        const element = document.createElement('div')
        element.setAttribute('dir', 'ltr')
        element.style.display = 'none' // shown by #render once its spread is ready (Simply Reader patch)
        const iframe = document.createElement('iframe')
        element.append(iframe)
        Object.assign(iframe.style, {
            border: '0',
            display: 'none',
            overflow: 'hidden',
        })
        // `allow-scripts` is needed for events because of WebKit bug
        // https://bugs.webkit.org/show_bug.cgi?id=218086
        iframe.setAttribute('sandbox', 'allow-same-origin allow-scripts')
        iframe.setAttribute('scrolling', 'no')
        iframe.setAttribute('part', 'filter')
        this.#root.append(element)
        if (!src) return { blank: true, element, iframe }
        return new Promise(resolve => {
            iframe.addEventListener('load', () => {
                const doc = iframe.contentDocument
                this.dispatchEvent(new CustomEvent('load', { detail: { doc, index } }))
                const { width, height } = getViewport(doc, this.defaultViewport)
                resolve({
                    element, iframe,
                    width: parseFloat(width),
                    height: parseFloat(height),
                    onZoom,
                })
            }, { once: true })
            iframe.src = src
        })
    }
    // (Simply Reader patch) the layout of any spread, shown or being prepared;
    // `frames` is { left, right } or { center }
    #layout(frames, side) {
        const left = frames.left ?? {}
        const right = frames.center ?? frames.right ?? {}
        const target = side === 'left' ? left : right
        const { width, height } = this.getBoundingClientRect()
        const portrait = this.spread !== 'both' && this.spread !== 'portrait'
            && height > width
        const blankWidth = left.width ?? right.width ?? 0
        const blankHeight = left.height ?? right.height ?? 0

        const scale = typeof this.#zoom === 'number' && !isNaN(this.#zoom)
            ? this.#zoom
            : (this.#zoom === 'fit-width'
                ? (portrait || frames.center
                    ? width / (target.width ?? blankWidth)
                    : width / ((left.width ?? blankWidth) + (right.width ?? blankWidth)))
                : (portrait || frames.center
                    ? Math.min(
                        width / (target.width ?? blankWidth),
                        height / (target.height ?? blankHeight))
                    : Math.min(
                        width / ((left.width ?? blankWidth) + (right.width ?? blankWidth)),
                        height / Math.max(
                            left.height ?? blankHeight,
                            right.height ?? blankHeight)))
            ) || 1
        return { left, right, target, portrait, blankWidth, blankHeight, scale }
    }
    // (Simply Reader patch) draws a spread's pages at this scale (PDF pages; a picture page is
    // decoded) and resolves once they're done
    #draw(frames, scale) {
        return Promise.all([frames.left, frames.right, frames.center].map(frame => {
            const doc = frame?.iframe?.contentDocument
            if (!doc || frame.blank) return null
            if (frame.onZoom) return frame.onZoom({ doc, scale })
            return doc.querySelector('img')?.decode?.().catch(() => {})
        }))
    }
    #render(side = this.#side) {
        if (!side) return
        const frames = this.#center ? { center: this.#center } : { left: this.#left, right: this.#right }
        const { left, right, target, portrait, blankWidth, blankHeight, scale } = this.#layout(frames, side)
        this.#portrait = portrait

        const transform = frame => {
            let { element, iframe, width, height, blank, onZoom } = frame
            if (!iframe) return
            const iframeScale = onZoom ? scale : 1
            Object.assign(iframe.style, {
                width: `${width * iframeScale}px`,
                height: `${height * iframeScale}px`,
                transform: onZoom ? 'none' : `scale(${scale})`,
                transformOrigin: 'top left',
                display: blank ? 'none' : 'block',
            })
            Object.assign(element.style, {
                width: `${(width ?? blankWidth) * scale}px`,
                height: `${(height ?? blankHeight) * scale}px`,
                overflow: 'hidden',
                display: 'block',
                flexShrink: '0',
                marginBlock: 'auto',
            })
            if (portrait && frame !== target) {
                element.style.display = 'none'
            }
        }
        if (this.#center) {
            transform(this.#center)
        } else {
            transform(left)
            transform(right)
        }
        return this.#draw(frames, scale)
    }
    #sideOf(frames, side) {
        return frames.center ? 'center'
            : frames.left?.blank ? 'right' : frames.right?.blank ? 'left' : side
    }
    // (Simply Reader patch) loads a spread's pages into hidden frames (once; later calls share it)
    #prepare(index) {
        const cached = this.#frames.get(index)
        if (cached) return cached.ready
        const spread = this.#spreads[index]
        const entry = {}
        const frame = async section => {
            const created = await this.#createFrame({
                index: this.book.sections.indexOf(section),
                src: await section?.load?.(),
            })
            if (this.#frames.get(index) !== entry) { // let go while loading (see #show)
                created.element.remove()
                throw Object.assign(new Error('spread no longer needed'), { name: 'StaleSpread' })
            }
            return created
        }
        entry.ready = (async () => {
            if (spread.center) entry.center = await frame(spread.center)
            else {
                entry.left = await frame(spread.left)
                entry.right = await frame(spread.right)
            }
            return entry
        })()
        entry.ready.catch(() => {
            if (this.#frames.get(index) === entry) this.#frames.delete(index)
            for (const f of [entry.left, entry.right, entry.center]) f?.element?.remove()
        })
        this.#frames.set(index, entry)
        return entry.ready
    }
    #show(index, entry, side) {
        for (const frame of [this.#left, this.#right, this.#center])
            if (frame?.element) frame.element.style.display = 'none'
        this.#index = index
        this.#left = entry.left ?? null
        this.#right = entry.right ?? null
        this.#center = entry.center ?? null
        this.#side = side
        this.#render()
        for (const [i, other] of this.#frames) if (i !== index && i !== index + 1) {
            this.#frames.delete(i)
            for (const frame of [other.left, other.right, other.center]) frame?.element?.remove()
        }
    }
    // the next spread, once a turn has settled (and any page-turn animation has run)
    #prepareNext() {
        clearTimeout(this.#prepareTimer)
        this.#prepareTimer = setTimeout(async () => {
            const index = this.#index
            if (index + 1 >= this.#spreads.length) return
            try {
                const entry = await this.#prepare(index + 1)
                if (this.#index !== index) return
                const side = this.#sideOf(entry, this.rtl ? 'right' : 'left')
                await this.#draw(entry, this.#layout(entry, side).scale)
            } catch (e) {
                if (e?.name !== 'StaleSpread') console.warn(e)
            }
        }, 600)
    }
    #goLeft() {
        if (this.#center || this.#left?.blank) return
        if (this.#portrait && this.#left?.element?.style?.display === 'none') {
            this.#side = 'left'
            this.#render()
            this.#reportLocation('page')
            return true
        }
    }
    #goRight() {
        if (this.#center || this.#right?.blank) return
        if (this.#portrait && this.#right?.element?.style?.display === 'none') {
            this.#side = 'right'
            this.#render()
            this.#reportLocation('page')
            return true
        }
    }
    open(book) {
        this.book = book
        const { rendition } = book
        this.spread = rendition?.spread
        this.defaultViewport = rendition?.viewport

        const rtl = book.dir === 'rtl'
        const ltr = !rtl
        this.rtl = rtl

        if (rendition?.spread === 'none')
            this.#spreads = book.sections.map(section => ({ center: section }))
        else this.#spreads = book.sections.reduce((arr, section, i) => {
            const last = arr[arr.length - 1]
            const { pageSpread } = section
            const newSpread = () => {
                const spread = {}
                arr.push(spread)
                return spread
            }
            if (pageSpread === 'center') {
                const spread = last.left || last.right ? newSpread() : last
                spread.center = section
            }
            else if (pageSpread === 'left') {
                const spread = last.center || last.left || ltr && i ? newSpread() : last
                spread.left = section
            }
            else if (pageSpread === 'right') {
                const spread = last.center || last.right || rtl && i ? newSpread() : last
                spread.right = section
            }
            else if (ltr) {
                if (last.center || last.right) newSpread().left = section
                else if (last.left || !i) last.right = section
                else last.left = section
            }
            else {
                if (last.center || last.left) newSpread().right = section
                else if (last.right || !i) last.left = section
                else last.right = section
            }
            return arr
        }, [{}])
    }
    get index() {
        const spread = this.#spreads[this.#index]
        if (!spread) return -1
        const section = spread?.center ?? (this.#side === 'left'
            ? spread.left ?? spread.right : spread.right ?? spread.left)
        return this.book.sections.indexOf(section)
    }
    #reportLocation(reason) {
        this.dispatchEvent(new CustomEvent('relocate', { detail:
            { reason, range: null, index: this.index, fraction: 0, size: 1 } }))
    }
    getSpreadOf(section) {
        const spreads = this.#spreads
        for (let index = 0; index < spreads.length; index++) {
            const { left, right, center } = spreads[index]
            if (left === section) return { index, side: 'left' }
            if (right === section) return { index, side: 'right' }
            if (center === section) return { index, side: 'center' }
        }
    }
    async goToSpread(index, side, reason) {
        if (index < 0 || index > this.#spreads.length - 1) return
        if (index === this.#index) {
            this.#render(side)
            return
        }
        // (Simply Reader patch) the new pages are loaded and drawn before they replace the old
        // ones, and the move is reported once they're on screen; a newer turn wins
        const gen = ++this.#gen
        let entry
        try {
            entry = await this.#prepare(index)
        } catch (e) {
            if (gen !== this.#gen) return
            throw e
        }
        if (gen !== this.#gen) return
        const shown = this.#sideOf(entry, side)
        await this.#draw(entry, this.#layout(entry, shown).scale)
        if (gen !== this.#gen) return
        this.#show(index, entry, shown)
        this.#reportLocation(reason)
        this.#prepareNext()
    }
    async select(target) {
        await this.goTo(target)
        // TODO
    }
    async goTo(target) {
        const { book } = this
        const resolved = await target
        const section = book.sections[resolved.index]
        if (!section) return
        const { index, side } = this.getSpreadOf(section)
        await this.goToSpread(index, side)
    }
    async next() {
        const s = this.rtl ? this.#goLeft() : this.#goRight()
        if (!s) return this.goToSpread(this.#index + 1, this.rtl ? 'right' : 'left', 'page')
    }
    async prev() {
        const s = this.rtl ? this.#goRight() : this.#goLeft()
        if (!s) return this.goToSpread(this.#index - 1, this.rtl ? 'left' : 'right', 'page')
    }
    getContents() {
        // the spread shown (prepared spreads are hidden frames too) (Simply Reader patch)
        return [this.#left, this.#right, this.#center].filter(frame => frame?.iframe)
            .map(frame => ({
                doc: frame.iframe.contentDocument,
                // TODO: index, overlayer
            }))
    }
    destroy() {
        this.#observer.unobserve(this)
        clearTimeout(this.#prepareTimer)
        this.#gen++
    }
}

customElements.define('foliate-fxl', FixedLayout)
