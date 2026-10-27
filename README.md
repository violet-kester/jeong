<div align="center">

<img src="jeong-logo-card.svg" alt="정" height="160">

<h1>Jeong</h1>

**Your life on a timeline.**

*Jeong* (정) is a Korean word for the deep, sticky bond that builds up between people over time.<br>
It grows between family, friends, neighbors, acquaintances, strangers, and even rivals.<br>
It can't be rushed. Like snow, it accumulates quietly over shared meals and umbrellas, the stairs you pass each other on every day, and the stories we tell.<br>
Koreans speak of *miun jeong* (미운 정) and *goun jeong* (고운 정), the *jeong* of hard times and of sweet ones, and both bring people closer.

---

An open source journal you read as a timeline instead of a list.

**Zoom** from a single day out to your whole life.<br>
**Capture** writing, photos, and voice.<br>
**Talk** by recording a quick voice note or chatting with a voice agent.<br>
**Share privately** with encryption and only your connections.
</div>

## Install the Obsidian plugin

Jeong isn't in Obsidian's Community plugins list. Install it with the [BRAT](https://obsidian.md/plugins?id=obsidian42-brat) plugin:

1. In Obsidian, open **Settings → Community plugins**, search for **BRAT**, install it, and enable it.
2. In BRAT's settings, choose **Add Beta plugin** and paste `https://github.com/violet-kester/jeong`.
3. Turn on the **Jeong** plugin under Community plugins.
4. Click 🎙️ **Record a new entry** or 🕘 **Open your timeline** in your ribbon sidebar.

BRAT keeps Jeong up to date on desktop and on phones.

## What you need

Jeong is local first. Out of the box, it runs entirely on your own computer with an open-source stack, so your recordings and stories never leave it. Nothing is sent to anyone, not even me.

1. **Recording and transcription:** nothing to install.
    - The speech models ([Moonshine](https://github.com/usefulsensors/moonshine) and [Whisper](https://github.com/openai/whisper)) run inside Obsidian and download the first time you record.
    - On a slower computer, choose **Moonshine only** under **Settings → Jeong → Live transcript model**.
2. **Stories and summaries:**
    - Install the [Ollama](https://ollama.com) model runner.
    - Install the Granite language model: run `ollama pull granite4:tiny-h`.
    - Without these, Jeong still saves your transcript and you can write the story later.
3. **Paintings:**
    - Install the [ComfyUI](https://www.comfy.org) image generator.
    - Install the [FLUX.2 klein](https://huggingface.co/black-forest-labs) image model in ComfyUI.
    - This needs a graphics card with about 8 GB of memory on a computer rather than a phone.
    - Without these, your entries will not be illustrated.

We recommend installing these. If you'd rather not, you can bring your own API key instead under **Settings → Jeong**:

- **Story writer:** Claude (Anthropic) or OpenAI
- **Painter:** OpenAI or Grok (xAI)

With cloud-based services like these, your transcripts, entries, and picture descriptions are sent to that company and billed to your account.
