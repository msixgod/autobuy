# Desktop App Plan

## Goal

Ship a single end-user desktop app for:

- Windows
- macOS

The app should:

- not require users to install external proxy tools
- capture the target Trasen API traffic from WeChat on desktop
- extract session and booking data automatically
- let users configure doctor / department / morning-afternoon / earliest-vs-specific-date
- directly create the order to lock the slot
- leave payment to the user afterward

## Product Shape

The final product is a desktop app with:

1. Cross-platform UI shell
2. Embedded HTTPS capture core
3. Booking task engine
4. First-run setup wizard for certificate and proxy trust

## Recommended Stack

### Shell

- Tauri 2

Why:

- one codebase for Windows and macOS
- small app footprint
- native packaging support
- frontend-agnostic UI

## Embedded Capture Core

Use a bundled local HTTPS proxy runtime per platform.

The user should not install it separately.

The app ships with:

- Windows proxy binary
- macOS proxy binary

The UI starts and stops the capture core as a child process.

## Core Modules

### 1. First-run Setup

- detect OS
- install / trust local root certificate
- help user enable proxy route for WeChat traffic
- validate traffic interception

### 2. Session Extractor

From captured traffic, extract:

- token
- orgCode
- patient list
- card list
- doctor ids and codes
- department ids and codes
- schedule parameters
- scheduleTime parameters
- order payload shape

### 3. Booking Engine

- choose earliest or specific date
- choose morning / afternoon / all-day
- optional start time pin
- poll booking endpoints
- create order immediately on hit
- persist task logs

### 4. User UI

- setup status
- capture status
- target doctor selection
- patient / card selection
- alert-only vs auto-order
- logs and last hit summary

## Packaging

### Windows

- installer build
- code signing later

### macOS

- DMG build
- notarization later

## First Practical Milestone

### Milestone 1

Build the desktop shell and local service orchestration.

Deliverables:

- open app
- start embedded capture core
- show proxy/cert setup state
- save app config locally

### Milestone 2

Import captured traffic and auto-extract:

- token
- patients
- cards
- doctor metadata

### Milestone 3

Run direct booking from the app:

- schedule polling
- scheduleTime polling
- order creation

## Constraints

- HTTPS interception still requires certificate trust on both OSes
- some setup actions may require elevated privileges
- WeChat desktop traffic behavior must be validated separately on Windows and macOS
- page/API changes on the hospital side can break extraction rules

## Decision

Proceed with a built-in desktop app architecture.
Do not require users to install mitmproxy, Fiddler, Charles, or HTTP Toolkit manually.
