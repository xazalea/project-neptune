/**
 * project: neptune — AI Engine Module v1.0.0
 * 
 * Integrates Chrome's Built-in AI APIs (Gemini Nano, on-device):
 *   - Prompt API (languageModel) — general-purpose LLM
 *   - Summarizer API — text summarization
 *   - Translator API — language translation
 *   - Language Detector API — language identification
 *   - Writer/Rewriter API — text refinement
 *
 * All models run ON-DEVICE via Gemini Nano. No data leaves the browser.
 * Falls back gracefully when APIs are not available (not yet downloaded,
 * browser doesn't support, etc.).
 *
 * Communication path:
 *   Direct: window.ai (Chrome 127+ built-in Gemini Nano APIs, on-device)
 */

'use strict';

const NeptuneAI = (function() {

  // ── State ──────────────────────────────────────────────
  let capabilities = null;

  // ── Capability Detection ──────────────────────────────

  /**
   * Detect available AI APIs.
   *   Uses direct window.ai access (available in Chrome 127+ with built-in AI flags).
   *   All models run on-device via Gemini Nano — no data leaves the browser.
   *
   * @returns {Promise<Object>} Capability map
   */
  async function detectCapabilities() {
    if (capabilities) return capabilities;

    const caps = {
      languageModel: { available: false, ready: false },
      summarizer: { available: false, ready: false },
      translator: { available: false, ready: false },
      languageDetector: { available: false, ready: false },
      mode: 'none', // 'direct'
    };

    // Path 1: Direct window.ai (Chrome 127+)
    if (typeof ai !== 'undefined') {
      caps.mode = 'direct';

      // Language Model
      if (ai.languageModel) {
        caps.languageModel.available = true;
        try {
          const status = await ai.languageModel.capabilities();
          caps.languageModel.ready = status === 'readily';
          caps.languageModel.status = status;
        } catch (e) {
          caps.languageModel.error = e.message;
        }
      }

      // Summarizer
      if (ai.summarizer) {
        caps.summarizer.available = true;
        try {
          const status = await ai.summarizer.capabilities();
          caps.summarizer.ready = status === 'readily';
          caps.summarizer.status = status;
        } catch (e) {
          caps.summarizer.error = e.message;
        }
      }

      // Translator
      if (ai.translator) {
        caps.translator.available = true;
        try {
          const status = await ai.translator.capabilities();
          caps.translator.ready = status === 'readily';
          caps.translator.status = status;
        } catch (e) {
          caps.translator.error = e.message;
        }
      }

      // Language Detector
      if (ai.languageDetector) {
        caps.languageDetector.available = true;
        try {
          const status = await ai.languageDetector.capabilities();
          caps.languageDetector.ready = status === 'readily';
          caps.languageDetector.status = status;
        } catch (e) {
          caps.languageDetector.error = e.message;
        }
      }

      capabilities = caps;
      return caps;
    }

    capabilities = caps;
    return caps;
  }

  // ── High-Level API ────────────────────────────────────

  /**
   * Send a prompt to the language model.
   * @param {string} prompt - The user prompt
   * @param {Object} opts - Options (temperature, topK, systemPrompt)
   * @returns {Promise<{response: string}>}
   */
  async function prompt(prompt, opts = {}) {
    const caps = await detectCapabilities();

    // Direct API path
    if (caps.mode === 'direct' && caps.languageModel.ready) {
      const session = await ai.languageModel.create({
        temperature: opts.temperature ?? 0.7,
        topK: opts.topK ?? 40,
        systemPrompt: opts.systemPrompt || 'You are a helpful assistant embedded in the Neptune browser proxy.',
      });
      const response = await session.prompt(prompt);
      session.destroy?.();
      return { response, mode: 'direct' };
    }

    // No AI available
    throw new Error('AI not available — enable Chrome built-in AI (chrome://flags/#prompt-api-for-gemini-nano)');
  }

  /**
   * Summarize text.
   * @param {string} text - Text to summarize
   * @param {Object} opts - Summarization options
   * @returns {Promise<{summary: string, method: string}>}
   */
  async function summarize(text, opts = {}) {
    const caps = await detectCapabilities();

    // Direct API path
    if (caps.mode === 'direct' && caps.summarizer.ready) {
      const summarizer = await ai.summarizer.create(opts);
      const summary = await summarizer.summarize(text);
      summarizer.destroy?.();
      return { summary, method: 'summarizer-api' };
    }

    // Fallback: use Prompt API
    try {
      const result = await prompt(
        `Please summarize the following text concisely, capturing the key points:\n\n${text}`,
        { temperature: 0.3 }
      );
      return { summary: result.response, method: 'prompt-api' };
    } catch (e) {
      // Last resort: extract first N characters
      const maxLen = opts.maxLength || 500;
      return {
        summary: text.substring(0, maxLen) + (text.length > maxLen ? '...' : ''),
        method: 'truncation',
      };
    }
  }

  /**
   * Translate text to another language.
   * @param {string} text - Text to translate
   * @param {string} targetLanguage - Target language code (e.g., "es", "fr", "de")
   * @param {string} sourceLanguage - Source language code (optional, auto-detect)
   * @returns {Promise<{translation: string, method: string}>}
   */
  async function translate(text, targetLanguage, sourceLanguage = null) {
    const caps = await detectCapabilities();

    // Direct API path
    if (caps.mode === 'direct' && caps.translator.ready) {
      const translator = await ai.translator.create({
        sourceLanguage: sourceLanguage || 'auto',
        targetLanguage,
      });
      const translation = await translator.translate(text);
      translator.destroy?.();
      return { translation, method: 'translator-api' };
    }

    // Fallback: use Prompt API
    const src = sourceLanguage ? ` from ${sourceLanguage}` : '';
    const result = await prompt(
      `Translate the following text${src} to ${targetLanguage}. Return ONLY the translated text, no explanations:\n\n${text}`,
      { temperature: 0.2 }
    );
    return { translation: result.response, method: 'prompt-api' };
  }

  /**
   * Detect language(s) of text.
   * @param {string} text - Text to analyze
   * @returns {Promise<{languages: Array<{language: string, confidence: number}>, method: string}>}
   */
  async function detectLanguage(text) {
    const caps = await detectCapabilities();

    // Direct API path
    if (caps.mode === 'direct' && caps.languageDetector.ready) {
      const detector = await ai.languageDetector.create();
      const results = await detector.detect(text);
      detector.destroy?.();
      return { languages: results, method: 'detector-api' };
    }

    // Fallback: heuristic detection via Unicode ranges
    const heuristicLang = detectLanguageHeuristic(text);
    return { languages: [{ language: heuristicLang, confidence: 0.5 }], method: 'heuristic' };
  }

  /**
   * Heuristic language detection based on Unicode character ranges.
   * Quick fallback when AI APIs aren't available.
   */
  function detectLanguageHeuristic(text) {
    if (!text) return 'en';
    const sample = text.substring(0, 200);

    // Check for common scripts
    const hasCJK = /[\u4e00-\u9fff\u3400-\u4dbf]/.test(sample);
    const hasHiragana = /[\u3040-\u309f]/.test(sample);
    const hasKatakana = /[\u30a0-\u30ff]/.test(sample);
    const hasHangul = /[\uac00-\ud7af]/.test(sample);
    const hasArabic = /[\u0600-\u06ff]/.test(sample);
    const hasCyrillic = /[\u0400-\u04ff]/.test(sample);
    const hasDevanagari = /[\u0900-\u097f]/.test(sample);
    const hasThai = /[\u0e00-\u0e7f]/.test(sample);
    const hasLatin = /[a-zA-Z]/.test(sample);

    if (hasHiragana || hasKatakana) return 'ja';
    if (hasCJK && !hasHiragana && !hasKatakana) return 'zh';
    if (hasHangul) return 'ko';
    if (hasArabic) return 'ar';
    if (hasCyrillic) return 'ru';
    if (hasDevanagari) return 'hi';
    if (hasThai) return 'th';
    if (hasLatin) return 'en';
    return 'en';
  }

  /**
   * Check if any AI feature is currently available.
   * @returns {Promise<boolean>}
   */
  async function isAvailable() {
    const caps = await detectCapabilities();
    return caps.languageModel.ready || caps.summarizer.ready || 
           caps.translator.ready || caps.languageDetector.ready;
  }

  /**
   * Get the current capabilities without re-detecting.
   * @returns {Object|null}
   */
  function getCapabilities() {
    return capabilities;
  }

  /**
   * Invalidate cached capabilities (force re-detect on next call).
   */
  function invalidateCapabilities() {
    capabilities = null;
  }

  // ── Export ────────────────────────────────────────────

  return {
    detectCapabilities,
    prompt,
    summarize,
    translate,
    detectLanguage,
    detectLanguageHeuristic,
    isAvailable,
    getCapabilities,
    invalidateCapabilities,
  };

})();

// Export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = NeptuneAI;
}
if (typeof window !== 'undefined') {
  window.NeptuneAI = NeptuneAI;
}
if (typeof self !== 'undefined') {
  self.NeptuneAI = NeptuneAI;
}
