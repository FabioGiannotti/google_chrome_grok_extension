# Media Downloader for Grok

**Estensione Chrome per intercettare, organizzare e scaricare automaticamente immagini e video generati con Grok (xAI), con iniezione dei prompt nei metadati.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Chrome Extension](https://img.shields.io/badge/Chrome-Extension-blue?logo=googlechrome)](https://github.com/FabioGiannotti/google-chrome-grok-extension)

> Estensione indipendente — non affiliata, sponsorizzata o approvata da xAI o Grok.

**Repository:** https://github.com/FabioGiannotti/google-chrome-grok-extension

---

## 📦 Installazione da GitHub (sorgente)

1. Clona il repository:
   ```bash
   git clone https://github.com/FabioGiannotti/google-chrome-grok-extension.git
   cd google-chrome-grok-extension
   ```

2. Apri Chrome e vai su `chrome://extensions/`

3. Attiva **Modalità sviluppatore** (in alto a destra)

4. Clicca su **"Carica estensione non pacchettizzata"**

5. Seleziona la cartella del progetto

L'estensione sarà subito disponibile. Ricarica qualsiasi pagina grok.com per attivarla.

---

## 🇮🇹 Descrizione

**Media Downloader for Grok** è uno strumento professionale che ti dà il pieno controllo sui media generati durante le conversazioni con Grok.

L'estensione:
- Intercetta automaticamente ogni immagine e video generato
- Arricchisce l'interfaccia di Grok con badge informativi e pulsanti rapidi
- Permette il salvataggio permanente in una **biblioteca locale offline**
- Esegue download di massa organizzati in cartelle (con prompt nei metadati EXIF/PNG)
- Funziona completamente in locale: zero dati inviati a server esterni

---

## ✨ Funzionalità Complete

### 1. Intercettazione Automatica
- Patch di `fetch` e `XMLHttpRequest` nel contesto della pagina (`inject.js`)
- Rileva risposte dalle API interne di Grok (`/rest/media/post/list`, endpoint `/imagine/`, domini `x.ai`)
- Estrae automaticamente: URL media, prompt, conteggi immagini/video, risoluzioni, durate, aspect ratio, ID post e relazioni (parent/child/extended)
- Deduplicazione intelligente (URL + parentId/filename)
- Notifiche desktop + badge sull'icona dell'estensione quando arrivano nuovi elementi
- Badge sull'icona: ● (attivo), ⏸ (in pausa), numero durante download, ★ (flash nuovo elemento)

### 2. Interfaccia Potenziata su grok.com (solo pagina Saved)
- **Badge informativi** sulle card: mostra 🖼️ N (immagini) e 🎥 N per risoluzione (SD / HD / 480p / 720p)
- **Pulsanti azione** in overlay:
  - ℹ️ → copia prompt negli appunti
  - 📸 → salva foto nella Biblioteca (ridimensionata a max 1280px)
  - 🎥 → salva video nella Biblioteca
- I pulsanti di salvataggio diventano ✅ (con bordo verde) quando l'elemento è già nella biblioteca
- **Video Reveal**: passa il mouse sull'icona di salvataggio foto su una card video → mostra temporaneamente l'immagine statica di anteprima
- **Pannello filtri flottante** (si apre da destra, con UX raffinata):
  - Sezione organizzata "Tipo di contenuto" con etichette chiare e tooltip
  - Solo foto (senza video)
  - Almeno un video
  - Più di un video
  - Tutti
  - "Forza immagini" (nasconde i video per vedere solo i frame)
  - Ricerca testuale nel prompt
  - Stili moderni con label migliorate per migliore leggibilità e accessibilità
- **Riordino manuale** (context menu tasto destro sulla pagina Saved → "Riordina (REORDER) Media per Data") o automatico se abilitato nelle impostazioni

Il codice sorgente è mantenuto pulito e ben organizzato (commenti non essenziali rimossi per leggibilità senza perdere la documentazione essenziale).

### 3. Popup Principale (clicca sull'icona dell'estensione)
Interfaccia completa di gestione della coda temporanea:

**Azioni Download**
- DOWNLOAD TUTTO
- DOWNLOAD SELEZIONATI (con contatore)
- DOWNLOAD IMMAGINI
- DOWNLOAD VIDEO

**Selezione avanzata**
- Checkbox per riga + "Seleziona tutto"
- Shift+Click per selezione a intervallo
- Selezione persistente tra filtri/viste

**Filtri e Vista**
- Filtro tipo: Tutto / Immagini / Video
- Filtro temporale: Sempre / Oggi / Ieri / Ultimi 3 gg / Ultima settimana / Ultimo mese
- Ricerca libera (filename, prompt, URL)
- Vista **Tabella** (raggruppata per prompt/parent con collapse) o **Griglia**
- Ordinamento colonne (clicca header) + pulsante rapido "↕ Nome"
- Anteprima hover (tabella) o click (griglia):
  - Video con controlli, loop, volume
  - Navigazione freccette (tastiera ← →) e pulsanti
  - Escape per chiudere

**Altri controlli**
- Svuota elenco
- Pausa / Riprendi intercettazione (utile durante download)
- Esporta JSON / CSV degli elementi visibili
- Log operazioni (modal con toggle registrazione)
- Pulsante pop-out (apre finestra sempre in primo piano, 1000x1200)
- Link rapido alla Biblioteca e alle Impostazioni

Durante i download viene mostrata una barra di progresso dettagliata:
- Percentuale + conteggio
- Byte ricevuti / totali
- Velocità (item/s e B/s)
- ETA
- Conteggio saltati (se skipExisting attivo)

### 4. Biblioteca Locale (library.html)
Archivio permanente offline, aperto dal popup o direttamente.

**Caratteristiche archiviazione**
- Sistema "decoupled": i metadati stanno in `libraryItems`, i dati pesanti (data: URL) in chiavi separate `lib_img_{id}`
- Migrazione automatica dal vecchio formato (base64 embedded)
- Gestisce centinaia di elementi senza appesantire lo storage manifest

**Filtri potenti**
- Ricerca testo (prompt/filename)
- Tipo: Tutti / Solo Immagini / Solo Video
- Aspect Ratio: tutte le principali (1:1, 16:9, 9:16, 4:3, 3:2, 2:3, 2.4:1 Cinema, ...)
- Periodo: Oggi / 3 giorni / Settimana / Questo mese / Mese scorso / >4 mesi / Anno scorso / Intervallo personalizzato (date picker)
- Utente (supporta multi-account Grok — filtra per email)
- Pulsanti densità griglia: Compatta / Normale / Grande (salvati in localStorage)

**Organizzazione**
- Card raggruppate per giorno (data di salvataggio)
- Hover video → autoplay silenzioso
- Click card → anteprima grande con:
  - Sfondo blur
  - Controlli video completi
  - Prompt completo, data, aspect ratio
  - Pulsanti "Copia Prompt" e "Scarica"

**Azioni per card**
- 📋 Copia prompt
- ⬇️ Scarica singolo (va in `Grok_Media/Library/`)
- 🗑️ Elimina

**Azioni globali**
- Esporta tutta la biblioteca (JSON)
- Svuota Biblioteca (con conferma)
- Pulsante speciale **"📥 Scarica 40 Video"** (Batch Video Tool)

**Batch Video Tool**
- Scarica i primi 40 video della biblioteca con ritmo accelerato
- Evidenzia la card in download
- Rimuove automaticamente il video dalla biblioteca dopo il download
- Se il video **non ha un'immagine companion** (stesso prompt, entro ~2 ore), salva il prompt in un file `prompts_....txt` nella cartella Library
- Barra di progresso dedicata + pulsante Stop
- Ideale per ripulire velocemente la biblioteca

**Statistiche (📊)**
- Totale file + spazio occupato
- Mix Immagini / Video
- Nuvola delle 30 keyword più frequenti nei prompt
- Grafico a barre: attività ultimi 7 giorni
- Barra quota storage con warning (giallo >75%, rosso >90%)

### 5. Download Manager & Organizzazione File (background)
- Code sequenziali con limiti di simultaneità
- Ritardi configurabili tra file e tra batch
- **Turbo Mode**: riduce drasticamente i ritardi (usa con cautela)
- Salvataggio strutturato:
  ```
  Downloads/
    Grok_Media/
      <prompt_sanitizzato_parent>/
        nomefile.jpg
        nomefile.mp4
      Library/
        ...
  ```
- `sanitizePath`: rimuove caratteri illegali, collassa spazi, max 60 char
- **Iniezione metadati** (se attivo):
  - JPEG: marker COM (`Prompt: ...`) subito dopo SOI
  - PNG: chunk tEXt "Description" + prompt (con CRC32 calcolato)
- Controllo "salta se già esistente" (basato su cronologia download Chrome)
- Retry automatico (max 3) su NETWORK_FAILED con backoff esponenziale
- Tracking byte-level per progress accurato

### 6. Impostazioni (pagina Opzioni)
Accessibile da:
- Icona ingranaggio nel popup
- `chrome://extensions` → Dettagli → Opzioni
- O direttamente `settings.html`

**Parametri di download**
- Ritardo singolo (ms)
- Grandezza Batch + Ritardo Batch (pausa lunga ogni N elementi)
- Download simultanei (max)
- Turbo Mode (override aggressivo)

**Dimensioni miniature**
- Larghezza e altezza thumb usate nel popup

**Toggle**
- Salva prompt nei metadati (EXIF/COM/tEXt)
- Salta file esistenti
- Suono notifica
- REORDER (ordina per data) sulla pagina Saved di Grok
- Turbo Mode

### 7. Altre Funzionalità
- **Context menu** su `grok.com/imagine/saved`: "Riordina (REORDER) Media per Data"
- **Icone dinamiche**: attive (colorate) solo su tab grok.com, inattive altrove
- **Keep-alive** service worker durante download lunghi
- Logging dettagliato (opzionale) con livelli info/success/warn/skip
- Supporto multi-tab / hot reload UI tramite listener storage e runtime messages
- Privacy assoluta: tutto resta nel tuo profilo browser (chrome.storage.local + sync per impostazioni)

---

## 🛠️ Come Usarla — Guida Passo-Passo

### Installazione
1. Apri `chrome://extensions/`
2. Attiva "Modalità sviluppatore"
3. "Carica estensione non pacchettizzata"
4. Seleziona la cartella di questo progetto

### Flusso tipico
1. Vai su [grok.com](https://grok.com) e genera immagini o video.
2. L'icona dell'estensione mostra un badge verde con il numero di nuovi media rilevati.
3. Apri il popup:
   - Usa filtri/ricerca/selezione
   - Clicca uno dei pulsanti di download
4. (Opzionale ma consigliato) Sulla pagina **Saved** di Grok:
   - Usa i pulsanti 📸 / 🎥 per salvare i preferiti nella Biblioteca
   - Usa il pannello filtri a destra
5. Apri la **Biblioteca** (pulsante 💾 nel popup) per:
   - Sfogliare in modo organizzato per giorno
   - Anteprime grandi
   - Download selettivi o batch video
   - Statistiche
6. Configura i ritardi nelle **Impostazioni** in base alla tua connessione e tolleranza ai rate limit.

### Scaricare solo alcuni elementi
- Seleziona le checkbox (o usa Shift+Click)
- Clicca "DOWNLOAD SELEZIONATI"

### Evitare doppioni
- Attiva "Salta file esistenti" nelle impostazioni
- Il motore controlla la cronologia download di Chrome

### Usare Turbo Mode
Solo quando sei sicuro di non avere problemi di rate limiting. Riduce ritardi a 50ms/500ms e alza max simultaneous.

### Riordinare la pagina Saved di Grok
- Abilita "REORDER" nelle impostazioni, oppure
- Tasto destro sulla pagina Saved → "Riordina (REORDER) Media per Data"

### Esportare dati
- Dal popup: JSON o CSV degli elementi filtrati/visualizzati
- Dalla Biblioteca: export completo JSON + tool batch che genera anche prompts.txt

---

## 📁 Struttura dei File Scaricati

```
Grok_Media/
├── Un_bel_prompt_lungo_che_.../
│   ├── abc123.jpg          ← con prompt nel metadato COM/tEXt
│   └── def456_720p.mp4
└── Library/
    ├── immagine_salvata.jpg
    └── video_batch.mp4
```

I nomi cartella derivano dal `parentPrompt` / `parentId` del post Grok (sanitizzati).

---

## 🔒 Privacy & Sicurezza

- Nessuna chiamata di rete verso server esterni (tranne le richieste necessarie per scaricare i file stessi)
- Tutti i dati (media, prompt, log, impostazioni) restano nel tuo browser
- Storage illimitato richiesto per gestire grandi quantità di anteprime in biblioteca
- I metadati vengono iniettati solo localmente prima del salvataggio

---

## 🐛 Note Tecniche & Limitazioni

- L'intercettazione funziona solo mentre navighi su domini consentiti (grok.com + assets x.ai)
- Alcune generazioni "estese" (video extension) vengono marcate `isSuperseded` o `isExtended`
- Le anteprime in biblioteca sono compresse (JPEG ~0.85) per risparmiare spazio; i download usano i dati originali
- Il reorder della pagina Saved è un'euristica DOM e potrebbe richiedere refresh o più tentativi su pagine molto dinamiche
- Turbo Mode può far scattare protezioni anti-abuso di Grok/xAI — usalo responsabilmente

---

## 🇺🇸 English Summary

**Media Downloader for Grok** automatically captures every image and video generated on Grok, enhances the Grok Saved page with useful badges and one-click save/copy buttons, provides a powerful local offline library with advanced filters + stats + batch video download, and performs organized bulk downloads while embedding the original prompt into JPEG (COM) and PNG (tEXt) metadata.

All features are described in detail in the Italian section above. The UI is fully localized in Italian.

---

## 📄 Licenza

Questo progetto è distribuito sotto licenza **MIT** — vedi il file [LICENSE](LICENSE) per i dettagli completi.

---

*Versione attuale dell'estensione: vedi `manifest.json` (1.0).*
*Ultimo aggiornamento documentazione: 2026-06-14*

Sviluppato per dare agli utenti il massimo controllo creativo e archivistico sulle generazioni Grok.