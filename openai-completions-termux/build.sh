#!/bin/sh

if [ ! -d ~/llama-swap ]; then
	cd ~ 
	git clone https://github.com/mostlygeek/llama-swap.git
fi

CGO_ENABLED=0 GOOS=android GOARCH=arm64 GOGC=50 \
	go build -p=2 -trimpath -ldflags="-s -w" -o ~/ls-build/llama-swap-termux ~/llama-swap
