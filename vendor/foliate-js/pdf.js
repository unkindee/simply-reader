const pdfjsPath = path => new URL(`vendor/pdfjs/${path}`, import.meta.url).toString()

import './vendor/pdfjs/pdf.mjs'
const pdfjsLib = globalThis.pdfjsLib
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsPath('pdf.worker.mjs')

const fetchText = async url => await (await fetch(url)).text()

// https://raw.githubusercontent.com/mozilla/pdf.js/refs/tags/v5.5.207/web/text_layer_builder.css
const textLayerBuilderCSS = await fetchText(pdfjsPath('text_layer_builder.css'))

// https://raw.githubusercontent.com/mozilla/pdf.js/refs/tags/v5.5.207/web/annotation_layer_builder.css
const annotationLayerBuilderCSS = await fetchText(pdfjsPath('annotation_layer_builder.css'))

// (Simply Reader patch) one worker for every PDF: starting one takes ~0.5 s on a slow tablet. It's
// passed to each document rather than set globally: a document destroys only a worker it made,
// so closing one PDF never stops the worker another open one (e.g. Book info) still uses.
let sharedWorker = null
const pdfWorker = () => {
    if (!sharedWorker || sharedWorker.destroyed) sharedWorker = new pdfjsLib.PDFWorker()
    return sharedWorker
}

// (Simply Reader patch) the largest page canvas, in pixels: a page drawn larger than this (a huge
// page at a high zoom) is stretched instead of needing more memory than the WebView allows
const MAX_CANVAS_PIXELS = /Android/.test(navigator.userAgent) ? 2 ** 24 : 2 ** 25

// (Simply Reader patch) `render` resolves once the page's picture is drawn (the text and link
// layers follow) and never rejects, and does nothing when the page is already drawn at this
// scale: the fixed-layout renderer asks on every layout, e.g. each turn within a spread.
// A render for a newer scale cancels the older one.
const render = (page, doc, zoom, onRendered) => {
    const scale = zoom * devicePixelRatio
    if (doc.srRender?.scale === scale) return doc.srRender.drawn
    doc.srRender?.task?.cancel()
    const job = doc.srRender = { scale }
    doc.documentElement.style.transform = `scale(${1 / devicePixelRatio})`
    doc.documentElement.style.transformOrigin = 'top left'
    doc.documentElement.style.setProperty('--scale-factor', scale)
    const viewport = page.getViewport({ scale })
    const fit = Math.min(1, Math.sqrt(MAX_CANVAS_PIXELS / (viewport.width * viewport.height)))
    const canvasViewport = fit < 1 ? page.getViewport({ scale: scale * fit }) : viewport

    job.drawn = (async () => {
        // the canvas must be in the `PDFDocument`'s `ownerDocument`
        // (`globalThis.document` by default); that's where the fonts are loaded
        const canvas = document.createElement('canvas')
        canvas.height = canvasViewport.height
        canvas.width = canvasViewport.width
        if (fit < 1) Object.assign(canvas.style, { width: `${viewport.width}px`, height: `${viewport.height}px` })
        const canvasContext = canvas.getContext('2d')
        job.task = page.render({ canvasContext, viewport: canvasViewport })
        await job.task.promise
        if (doc.srRender !== job) return false
        doc.querySelector('#canvas').replaceChildren(doc.adoptNode(canvas))
        return true
    })().catch(e => {
        if (e?.name !== 'RenderingCancelledException') {
            console.warn(e)
            if (doc.srRender === job) doc.srRender = null // tried again at the next layout
        }
        return false
    })
    job.drawn
        .then(drawn => drawn && doc.srRender === job && renderLayers(page, doc, viewport, job))
        .catch(e => console.warn(e))
        .finally(() => onRendered?.())
    return job.drawn
}

const renderLayers = async (page, doc, viewport, job) => {
    const container = doc.querySelector('.textLayer')
    container.replaceChildren() // a new scale replaces the layer (it used to be added again)
    const textLayer = new pdfjsLib.TextLayer({
        textContentSource: await page.streamTextContent(),
        container, viewport,
    })
    await textLayer.render()
    if (doc.srRender !== job) return

    // hide "offscreen" canvases appended to docuemnt when rendering text layer
    // https://github.com/mozilla/pdf.js/blob/642b9a5ae67ef642b9a8808fd9efd447e8c350e2/web/pdf_viewer.css#L51-L58
    for (const canvas of document.querySelectorAll('.hiddenCanvasElement'))
        Object.assign(canvas.style, {
            position: 'absolute',
            top: '0',
            left: '0',
            width: '0',
            height: '0',
            display: 'none',
        })

    // fix text selection
    // https://github.com/mozilla/pdf.js/blob/642b9a5ae67ef642b9a8808fd9efd447e8c350e2/web/text_layer_builder.js#L105-L107
    const endOfContent = document.createElement('div')
    endOfContent.className = 'endOfContent'
    container.append(endOfContent)
    // TODO: this only works in Firefox; see https://github.com/mozilla/pdf.js/pull/17923
    container.onpointerdown = () => container.classList.add('selecting')
    container.onpointerup = () => container.classList.remove('selecting')

    const div = doc.querySelector('.annotationLayer')
    div.replaceChildren()
    const linkService = {
        goToDestination: () => {},
        getDestinationHash: dest => JSON.stringify(dest),
        addLinkAttributes: (link, url) => link.href = url,
    }
    await new pdfjsLib.AnnotationLayer({ page, viewport, div, linkService })
        .render({ annotations: await page.getAnnotations() })
}

const renderPage = async (page, getImageBlob, onRendered) => {
    let viewport = page.getViewport({ scale: 1 })
    if (getImageBlob) {
        // cover image: render large enough for a sharp ~800px-wide library cover
        viewport = page.getViewport({ scale: Math.min(4, Math.max(1, 800 / viewport.width)) })
        const canvas = document.createElement('canvas')
        canvas.height = viewport.height
        canvas.width = viewport.width
        const canvasContext = canvas.getContext('2d')
        await page.render({ canvasContext, viewport }).promise
        return new Promise(resolve => canvas.toBlob(resolve))
    }
    const src = URL.createObjectURL(new Blob([`
        <!DOCTYPE html>
        <html lang="en">
        <meta charset="utf-8">
        <meta name="viewport" content="width=${viewport.width}, height=${viewport.height}">
        <style>
        html, body {
            margin: 0;
            padding: 0;
        }
        /*
        https://github.com/mozilla/pdf.js/commit/bd05b255fabfc313b194bfe9a17ccded4d90fb5a
        */
        :root {
          --user-unit: 1;
          --total-scale-factor: calc(var(--scale-factor) * var(--user-unit));
          --scale-round-x: 1px;
          --scale-round-y: 1px;
        }
        ${textLayerBuilderCSS}
        ${annotationLayerBuilderCSS}
        </style>
        <div id="canvas"></div>
        <div class="textLayer"></div>
        <div class="annotationLayer"></div>
    `], { type: 'text/html' }))
    const onZoom = ({ doc, scale }) => render(page, doc, scale, onRendered)
    return { src, onZoom }
}

const makeTOCItem = item => ({
    label: item.title,
    href: JSON.stringify(item.dest),
    subitems: item.items.length ? item.items.map(makeTOCItem) : null,
})

export const makePDF = async file => {
    const transport = new pdfjsLib.PDFDataRangeTransport(file.size, [])
    transport.requestDataRange = (begin, end) => {
        file.slice(begin, end).arrayBuffer().then(chunk => {
            transport.onDataRange(begin, chunk)
        })
    }
    const pdf = await pdfjsLib.getDocument({
        range: transport,
        worker: pdfWorker(),
        cMapUrl: pdfjsPath('cmaps/'),
        standardFontDataUrl: pdfjsPath('standard_fonts/'),
        isEvalSupported: false,
    }).promise

    const book = { rendition: { layout: 'pre-paginated' } }

    const { metadata, info } = await pdf.getMetadata() ?? {}
    // TODO: for better results, parse `metadata.getRaw()`
    book.metadata = {
        title: metadata?.get('dc:title') ?? info?.Title,
        author: metadata?.get('dc:creator') ?? info?.Author,
        contributor: metadata?.get('dc:contributor'),
        description: metadata?.get('dc:description') ?? info?.Subject,
        language: metadata?.get('dc:language'),
        publisher: metadata?.get('dc:publisher'),
        subject: metadata?.get('dc:subject'),
        identifier: metadata?.get('dc:identifier'),
        source: metadata?.get('dc:source'),
        rights: metadata?.get('dc:rights'),
    }

    const outline = await pdf.getOutline()
    book.toc = outline?.map(makeTOCItem)

    // (Simply Reader patch) pdf.js keeps data for every page it has drawn; like its own viewer,
    // let it go once reading has paused for half a minute (pages on screen stay as they are)
    let idle
    const cleanUpSoon = () => {
        clearTimeout(idle)
        idle = setTimeout(() => pdf.cleanup().catch(() => {}), 30000)
    }

    const cache = new Map()
    const texts = new Map() // page index -> its text, for search and word counts
    book.sections = Array.from({ length: pdf.numPages }).map((_, i) => ({
        id: i,
        load: async () => {
            const cached = cache.get(i)
            if (cached) return cached
            const url = await renderPage(await pdf.getPage(i + 1), false, cleanUpSoon)
            cache.set(i, url)
            return url
        },
        // (Simply Reader patch) plain-text version of the page so in-book search works for PDFs;
        // the text is kept, so searching again doesn't extract every page again
        createDocument: async () => {
            let text = texts.get(i)
            if (text == null) {
                const page = await pdf.getPage(i + 1)
                const { items } = await page.getTextContent()
                text = items.map(item => item.str + (item.hasEOL ? ' ' : '')).join('')
                texts.set(i, text)
            }
            const doc = document.implementation.createHTMLDocument('')
            const p = doc.createElement('p')
            p.textContent = text
            doc.body.append(p)
            return doc
        },
        size: 1000,
    }))
    book.isExternal = uri => /^\w+:/i.test(uri)
    book.resolveHref = async href => {
        const parsed = JSON.parse(href)
        const dest = typeof parsed === 'string'
            ? await pdf.getDestination(parsed) : parsed
        const index = await pdf.getPageIndex(dest[0])
        return { index }
    }
    book.splitTOCHref = async href => {
        const parsed = JSON.parse(href)
        const dest = typeof parsed === 'string'
            ? await pdf.getDestination(parsed) : parsed
        const index = await pdf.getPageIndex(dest[0])
        return [index, null]
    }
    book.getTOCFragment = doc => doc.documentElement
    book.getCover = async () => renderPage(await pdf.getPage(1), true)
    book.destroy = () => {
        clearTimeout(idle)
        return pdf.destroy()
    }
    return book
}
