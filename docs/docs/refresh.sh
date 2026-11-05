#!/bin/sh
# refresh.sh — re-clip the vendored writing guides (what and why: README.md).
#
# Google has no Markdown upstream (rendered HTML, so a converter is the only
# path); Microsoft authors in Markdown, so its source tree is copied rather than
# scraped. Google's page discovery reads the index pages' own links, so a new
# upstream page is picked up while a vanished one fails loudly instead of leaving
# a silently stale file.
#
# Needs curl, git and uv (for the throwaway python env). Network on purpose:
# this is the one file here that must reach upstream.
set -eu

here=$(CDPATH='' cd "$(dirname "$0")" && pwd)
MS_REPO=https://github.com/MicrosoftDocs/microsoft-style-guide.git
UA='Mozilla/5.0 (agentcontainer docs refresh)'

die() {
	printf 'refresh.sh: %s\n' "$*" >&2
	exit 1
}

# One rendered Google page -> one Markdown file.
to_md() {
	uv run --quiet --with markdownify --with beautifulsoup4 python - "$1" "$2" "$3" <<'PY'
import re, sys
from bs4 import BeautifulSoup
from markdownify import markdownify as md

html_path, url, clip_date = sys.argv[1], sys.argv[2], sys.argv[3]
soup = BeautifulSoup(open(html_path, encoding="utf-8", errors="replace").read(), "html.parser")
# The article container's class has moved (devsite-article-inner -> devsite-article),
# so this is a preference order, not a fact about today's markup: a silent fall
# through to <body> would vendor a page of navigation chrome.
node = (soup.select_one("article.devsite-article")
        or soup.select_one("article.devsite-article-inner")
        or soup.select_one(".devsite-article-body")
        or soup.select_one("main#main") or soup.select_one("main")
        or soup.body)
# Chrome around the article: breadcrumbs, the TOC, the feedback and rating
# widgets, and Google's material-icons ligature text (markdownify would
# otherwise emit it as the word "outlined_flag").
for bad in node.select("nav, script, style, footer, button, form, devsite-toc,"
                       " devsite-feedback, devsite-recommendations, devsite-thumb-rating,"
                       " devsite-floating-action-buttons, devsite-content-footer,"
                       " .devsite-article-meta, .devsite-page-title-meta,"
                       " .devsite-breadcrumb-list, .material-icons,"
                       " .nocontent, #devsite-collections-dropdown, template,"
                       " [class*=feedback], [class*=thumb-rating]"):
    bad.decompose()
# Google injects a collections widget INTO the h1, so its text arrives glued to
# the title; cut at the widget's own first words rather than guess at its markup.
h1 = node.find("h1")
if h1 is not None:
    title = re.split(r"Stay organized with collections|Save and categorize content",
                     h1.get_text(" ", strip=True))[0].strip()
    h1.clear()
    h1.append(title)
text = md(str(node), heading_style="ATX", strip=["img"])
text = re.sub(r"\n{3,}", "\n\n", text).strip()
sys.stdout.write("<!-- source: %s -->\n<!-- clipped: %s -->\n\n%s\n" % (url, clip_date, text))
PY
}

fetch_google() {
	command -v uv >/dev/null 2>&1 || die "uv is required to convert the Google pages"
	clip_date=$(date -u +%F)
	tmp=$(mktemp -d)
	trap 'rm -rf "$tmp"' EXIT

	for index in style tech-writing/one tech-writing/two; do
		curl -sS --max-time 60 -A "$UA" -o "$tmp/index.html" \
			"https://developers.google.com/$index" ||
			die "cannot fetch the index page /$index"
		grep -ohE 'href="/(style|tech-writing)/[a-z0-9/-]+"' "$tmp/index.html"
	done >"$tmp/links.txt"

	{
		printf '%s\n' style tech-writing tech-writing/one tech-writing/two
		cat "$tmp/links.txt"
	} | sed 's/.*href="//; s/"$//; s|^/||' | awk 'length' | sort -u >"$tmp/pages.txt"

	miss=0
	while read -r page; do
		code=$(curl -sS --max-time 60 -A "$UA" -o "$tmp/page.html" -w '%{http_code}' \
			"https://developers.google.com/$page") || code=ERR
		sleep 0.3
		if [ "$code" != 200 ]; then
			# A redirect or a removed page is upstream news, not a conversion
			# failure: keep going and say so — the existing copy stays until a
			# human decides what replaced it.
			printf 'MISS %s %s\n' "$code" "$page" >&2
			miss=$((miss + 1))
			continue
		fi
		case $page in
		style) out="$here/google-style/index.md" ;;
		style/*) out="$here/google-style/${page#style/}.md" ;;
		tech-writing) out="$here/google-tech-writing/index.md" ;;
		tech-writing/*/*) out="$here/google-tech-writing/${page#tech-writing/}.md" ;;
		# a section landing page (/tech-writing/one) keeps the folder's index spelling
		tech-writing/*) out="$here/google-tech-writing/${page#tech-writing/}/index.md" ;;
		*) printf 'SKIP unmapped page %s\n' "$page" >&2 && continue ;;
		esac
		mkdir -p "$(dirname "$out")"
		to_md "$tmp/page.html" "https://developers.google.com/$page" "$clip_date" >"$out"
	done <"$tmp/pages.txt"
	printf 'google: done (%s miss)\n' "$miss"
}

fetch_microsoft() {
	command -v git >/dev/null 2>&1 || die "git is required for the Microsoft source"
	tmp=$(mktemp -d)
	trap 'rm -rf "$tmp"' EXIT
	git clone --depth 1 --quiet "$MS_REPO" "$tmp/ms" || die "cannot clone $MS_REPO"
	sha=$(git -C "$tmp/ms" rev-parse HEAD)

	# Markdown only: media/ is images the live site serves, and vendoring them
	# would double the folder for no reading value.
	find "$tmp/ms/styleguide" -name '*.md' | while read -r src; do
		rel=${src#"$tmp/ms/"}
		mkdir -p "$here/microsoft-style/$(dirname "$rel")"
		cp "$src" "$here/microsoft-style/$rel"
	done
	cp "$tmp/ms/LICENSE" "$here/microsoft-style/LICENSE"
	printf 'microsoft: done (upstream %s)\n' "$sha"
}

case ${1:-all} in
all)
	fetch_google
	fetch_microsoft
	;;
google) fetch_google ;;
microsoft) fetch_microsoft ;;
*) die 'usage: ./refresh.sh [all|google|microsoft]' ;;
esac
printf 'now update the clip date and upstream sha in README.md\n'
