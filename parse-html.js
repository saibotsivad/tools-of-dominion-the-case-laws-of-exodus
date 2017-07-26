const fs = require('fs')
const cheerio = require('cheerio')
const match = require('better-match')
const entries = require('ordered-entries')

const {
	ROW_TYPE,
	flatMap,
	int
} = require('./shared')

function rangeInclusive(from, to) {
	const size = to - from + 1
	return new Array(size).fill(null).map((_, i) => i + from)
}

function main() {
	const files = rangeInclusive(9, 1295).map(i => `./html/page${i}.html`)
	// const files = rangeInclusive(35, 72).map(i => `./html/page${i}.html`)
	// const files = rangeInclusive(504, 504).map(i => `./html/page${i}.html`)
	console.log(files)

	const allFileContents = files.map(file => fs.readFileSync(file, { encoding: 'utf8' }))

	console.log('Done reading in all files')

	// identify italic text - span class is /^#f\d+ { .+ font-style:italic;/
	// identify footnote reference numbers - span font-size is no greater than 7px, contains only \d+
	// identify footnotes: div.txt left is at least 68px, span font-size is no greater than 8px, line text starts with \d+.
	// headers: font size at least 10px
	// chapter numbers: left at least 170px contains \d+

	const intermediate = flatMap(allFileContents, fileText => {
		const idToStyles = idStyleMap(fileText)

		const $ = cheerio.load(fileText)
		const rows = mapEach($('body > div.txt'), container => {
			const divStyle = styleStringToMap(container.attribs.style)

			const rowContents = mapEach($('span', container), span => {
				const { id, style } = span.attribs

				const spanStyle = Object.assign(styleStringToMap(style), idToStyles[id])

				return {
					text: $(span).text(),
					style: spanStyle
				}
			})

			return {
				sections: rowContents,
				style: divStyle,
			}
		})


		return processRows(rows)
	})

	fs.writeFileSync('./intermediate/content.json', JSON.stringify(intermediate, null, '\t'))
}


// text sections includes chapter numbers, headers, footnote references
// footnote sections include footnote starts and footnote text

const rowHandlers = {
	[ROW_TYPE.CHAPTER_NUMBER]: function rowIsChapterNumber(row, { first }) {
		return first
			&& row.sections.length === 1
			&& int(row.style.top) > 120
			&& allDigits(row.sections[0].text)
	},
	[ROW_TYPE.CHAPTER_HEADING]: function rowIsChapterHeading(row) {
		return int(row.style.top) < 200
			&& row.sections.every(section => allUppercase(section.text))
	},
	[ROW_TYPE.INTRO_VERSE]: function rowIsIntroVerse(row, { seen, lastRow }) {
		const gapSinceLastRow = lastRow && isGapBetweenRows(lastRow, row)
		const couldBeBodyText = seen[ROW_TYPE.INTRO_VERSE] && gapSinceLastRow

		return seen[ROW_TYPE.CHAPTER_HEADING]
			&& !seen[ROW_TYPE.BODY]
			&& !couldBeBodyText
			&& int(row.style.left) > 50
	},
	[ROW_TYPE.PAGE_HEADER]: (row, { lastRow, seen }) => {
		const pageNumberAtTop = !seen[ROW_TYPE.BODY] && int(row.style.top) < 50

		const pageNumberAtBottom = seen[ROW_TYPE.CHAPTER_HEADING]
			&& seen[ROW_TYPE.BODY]
			&& distanceBetweenRows(lastRow, row) > 15
			&& allDigits(row.sections[0].text)
			&& int(row.style.top) > 560

		return pageNumberAtTop || pageNumberAtBottom
	},
	[ROW_TYPE.FOOTNOTE]: function isFootnoteRow(row, { seen, lastRow }) {
		const isFirstFootnoteRow = seen[ROW_TYPE.BODY]
			&& !seen[ROW_TYPE.FOOTNOTE]
			&& startsWithDigits(row.sections[0].text)
			&& isGapBetweenRows(lastRow, row)
			&& row.sections.some(section => int(section.style.fontSize) <= 9)

		return isFirstFootnoteRow
			|| seen[ROW_TYPE.FOOTNOTE]
	},
	[ROW_TYPE.BODY]: function isBodyRow(row, { seen, lastRow }) {
		const isFirstBodyRowAfterIntro = seen[ROW_TYPE.INTRO_VERSE]
			&& !seen[ROW_TYPE.BODY]
			&& isGapBetweenRows(lastRow, row)

		return isFirstBodyRowAfterIntro
			|| !seen[ROW_TYPE.FOOTNOTE]
	},
}

function processRows(rows) {
	return rowsFlatMapWithMeta(rows, (row, meta) => {
		const match = entries(rowHandlers).find(([ , comparator ]) => comparator(row, meta))
		assert(match !== undefined, `No row handler found for ${row}`)

		const [ key ] = match

		return {
			rowType: key,
			row
		}
	})
}

function rowsFlatMapWithMeta(array, fn) {
	const seen = Object.create(null)
	let first = true
	let lastRow = null

	return flatMap(array, row => {
		const meta = { first, seen, lastRow }
		const result = fn(row, meta)

		seen[result.rowType] = true

		first = false
		lastRow = row

		return result
	})
}









function sectionIsItalic(section) {
	return section.style.fontStyle === 'italic'
}

function extractChapterNumber(row) {
	return int(row.sections[0].text)
}







const allDigits = str => /^\d+$/.test(str)
const startsWithDigits = str => /^\d+/.test(str)
const allUppercase = str => /^[^a-z]+$/.test(str)
const distanceBetweenRows = (firstRow, secondRow) => Math.abs(int(firstRow.style.top) - int(secondRow.style.top))
const isGapBetweenRows = (firstRow, secondRow) => distanceBetweenRows(firstRow, secondRow) > 20

function idStyleMap(html) {
	const map = Object.create(null)

	match(/\n#(f\d+) \{([^}]+)\}\n/, html).forEach(([ id, styles ]) => {
		map[id] = styleStringToMap(styles)
	})

	return map
}

const grabAllRowText = row => row.sections.map(({ text }) => text).join('')

function styleStringToMap(styles) {
	const styleMap = Object.create(null)

	styles.split(';')
		.map(style => style.split(':'))
		.filter(([ key ]) => key.trim())
		.forEach(([ key, value ]) => {
			styleMap[camelCase(key.trim())] = value.trim()
		})

	return styleMap
}

const mapEach = (cheerioResults, fn) => extract(cheerioResults).map(element => fn(element))
const extract = cheerioResults => {
	const array = []

	cheerioResults.each((index, element) => array.push(element))

	return array
}

function assert(value, message) {
	if (!value) {
		throw new Error(message || `ASSERT!`)
	}
}

function camelCase(str) {
	return str.replace(/[_.-](\w|$)/g, function(_, x) {
		return x.toUpperCase()
	})
}

main()