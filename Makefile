.PHONY: report stats concurrency clean help
.DEFAULT_GOAL := help

# Период и репозитории задаются при вызове:
#   make report FROM=2026-07-06 TO=2026-07-31 REPOS="~/projects/foo ~/pet/bar"
FROM ?=
TO   ?=
REPOS ?=
OUT  ?= dashboard.html

REPO_FLAGS := $(foreach r,$(REPOS),--repo $(r))

check-dates:
ifeq ($(strip $(FROM))$(strip $(TO)),)
	$(error укажи период: make report FROM=2026-07-06 TO=2026-07-31)
endif

report: check-dates ## Собрать HTML-дашборд за период (FROM, TO, REPOS)
	./weekly.py $(FROM) $(TO) > weekly.json
ifeq ($(strip $(REPOS)),)
	./build_html.py weekly.json -o $(OUT)
	@echo 'git не подключён — укажи REPOS="путь ..." , чтобы добавить коммиты'
else
	./git_stats.py $(FROM) $(TO) $(REPO_FLAGS) > git.json
	./build_html.py weekly.json --git git.json -o $(OUT)
endif
	@echo "готово: $(CURDIR)/$(OUT)"

stats: check-dates ## Текстовая сводка за период
	./stats.py $(FROM) $(TO)

concurrency: check-dates ## Параллелизм за период
	./concurrency.py $(FROM) $(TO)

clean: ## Удалить сгенерированные файлы
	rm -f weekly.json git.json $(OUT)

help: ## Показать эту справку
	@grep -hE '^[a-z-]+:.*?## ' $(MAKEFILE_LIST) | awk -F':.*?## ' '{printf "  %-14s %s\n", $$1, $$2}'
	@echo ''
	@echo '  пример: make report FROM=2026-07-06 TO=2026-07-31 REPOS="~/projects/foo"'
