import { esquemaLimpio, type DefinicionHerramienta, type LlamadaHerramienta, type LlmAdapter, type Mensaje, type RespuestaLlm } from "./adapter.ts"

// Groq expone una API compatible con OpenAI (chat/completions + tools). Se usa fetch: sin dependencias nuevas.

const URL_GROQ = "https://api.groq.com/openai/v1/chat/completions"

interface LlamadaGroq {
  id: string
  type: "function"
  function: { name: string; arguments: string }
}

type MensajeGroq =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: LlamadaGroq[] }
  | { role: "tool"; tool_call_id: string; name: string; content: string }

interface RespuestaGroq {
  choices?: { message?: { content?: string | null; tool_calls?: LlamadaGroq[] } }[]
  usage?: { prompt_tokens?: number; completion_tokens?: number }
  error?: { message?: string; code?: string }
}

/** Traduce el formato interno al de OpenAI: los argumentos de tool_calls viajan como string JSON. */
function convertir(mensajes: Mensaje[]): MensajeGroq[] {
  return mensajes.map((m): MensajeGroq => {
    if (m.rol === "tool") return { role: "tool", tool_call_id: m.id, name: m.nombre, content: m.contenido }
    if (m.rol === "assistant") {
      const tool_calls = m.llamadas.map((l): LlamadaGroq => ({ id: l.id, type: "function", function: { name: l.nombre, arguments: JSON.stringify(l.args ?? {}) } }))
      return tool_calls.length ? { role: "assistant", content: m.texto || null, tool_calls } : { role: "assistant", content: m.texto }
    }
    return { role: m.rol, content: m.texto }
  })
}

/** Argumentos inválidos no lanzan: llegan como objeto vacío y zod devuelve el error al modelo. */
function argumentos(texto: string): unknown {
  try {
    return JSON.parse(texto || "{}") as unknown
  } catch {
    return {}
  }
}

/** Segundos que Groq pide esperar ante un 429 (cabecera retry-after o texto "try again in 2.28s"). */
function esperaSugerida(r: Response, mensaje: string): number {
  const cabecera = Number(r.headers.get("retry-after"))
  if (Number.isFinite(cabecera) && cabecera > 0) return cabecera
  const m = /try again in ([\d.]+)s/i.exec(mensaje)
  return m ? Number(m[1]) : 5
}

const dormir = (ms: number) => new Promise((resolver) => setTimeout(resolver, ms))

/** Máximo de reintentos ante 429 y espera máxima por reintento (plan gratuito: topes de tokens por minuto). */
const REINTENTOS_429 = 4
const ESPERA_MAX_S = 20

export function crearGroq(modelo: string, timeoutMs: number): LlmAdapter {
  const apiKey = process.env.GROQ_API_KEY
  if (!apiKey) throw new Error("falta GROQ_API_KEY en el entorno del backend")
  return {
    proveedor: "groq",
    modelo,
    async enviar(mensajes: Mensaje[], herramientas: DefinicionHerramienta[]): Promise<RespuestaLlm> {
      const cuerpo = JSON.stringify({
          model: modelo,
          temperature: 0,
          // Groq cuenta max_tokens dentro del tope de tokens por minuto: se pide solo lo necesario.
          max_tokens: 1200,
          // Los modelos gpt-oss razonan antes de responder; "low" gasta menos tokens del cupo por minuto.
          ...(modelo.startsWith("openai/gpt-oss") ? { reasoning_effort: "low" } : {}),
          messages: convertir(mensajes),
          tools: herramientas.map((h) => ({
            type: "function",
            function: { name: h.nombre, description: h.descripcion, parameters: esquemaLimpio(h.parametros) },
          })),
          tool_choice: "auto",
      })
      const inicio = Date.now()
      let r: Response
      let datos: RespuestaGroq
      for (let intento = 0; ; intento++) {
        r = await fetch(URL_GROQ, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(timeoutMs),
          body: cuerpo,
        })
        datos = (await r.json().catch(() => ({}))) as RespuestaGroq
        if (r.status !== 429 || intento >= REINTENTOS_429) break
        // Tope de tokens por minuto: se espera lo que Groq indica, sin pasar del timeout total.
        const espera = Math.min(esperaSugerida(r, datos.error?.message ?? ""), ESPERA_MAX_S) * 1000 + 250
        if (Date.now() - inicio + espera > timeoutMs) break
        await dormir(espera)
      }
      // Mensaje propio, sin ids de organización, cabeceras ni la clave.
      if (r.status === 429) throw new Error("Groq alcanzó su límite de tokens por minuto (plan gratuito). Espera un minuto y reintenta.")
      if (r.status === 401) throw new Error("Groq rechazó la clave (GROQ_API_KEY inválida o revocada).")
      if (r.status === 404) throw new Error(`Groq no encontró el modelo ${modelo} o la clave no tiene acceso a él.`)
      if (!r.ok) throw new Error(`Groq respondió ${r.status}.`)
      const mensaje = datos.choices?.[0]?.message
      const llamadas: LlamadaHerramienta[] = (mensaje?.tool_calls ?? []).map((c) => ({ id: c.id, nombre: c.function.name, args: argumentos(c.function.arguments) }))
      return {
        texto: mensaje?.content ?? "",
        llamadas,
        tokens: (datos.usage?.prompt_tokens ?? 0) + (datos.usage?.completion_tokens ?? 0),
      }
    },
  }
}
