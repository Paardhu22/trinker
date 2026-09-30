# @trinker/report

JSON, Markdown, and SARIF rendering for [Trinker](https://github.com/Paardhu22/trinker) scans.
Every format states up front whether the scan can be trusted, so "0 findings" is never confused
with "nothing was tested". Accepted findings are emitted as SARIF suppressions.
