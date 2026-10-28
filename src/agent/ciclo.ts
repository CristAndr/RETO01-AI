import { readFile } from "node:fs/promises"
import path from "node:path"
import { config } from "../config.ts"
import { correoDelMensaje, esConfirmacion, otorgarConfirmacion, otorgarPermiso, revocarPermisos } from "../domain/confirmaciones.ts"
import type { Remitente } from "../domain/correo.ts"
import { esClaveBancaria, leerReglas } from "../domain/reglas.ts"
import { mensajeDeError } from "../domain/resultado.ts"
import type { DefinicionHerramienta, LlamadaHerramienta, LlmAdapter, Mensaje } from "../llm/adapter.ts"
import { buscarHerramienta, herramientas } from "../tools/registro.ts"
import type { Sesion, ToolCallVisible } from "./sesiones.ts"

export interface RespuestaTurno {
  reply: string
  toolCalls: ToolCallVisible[]
  needsConfirmation: boolean
  /** El front muestra el campo de correo (HU-7) tras un envío simulado. */
  pideCorreo: boolean
}

const VIGENCIA_CONFIRMACION_MS = 10 * 60 * 1000

const todas: DefinicionHerramienta[] = herramientas.map((h) => ({ nombre: h.nombre, descripcion: h.descripcion, parametros: h.parametros }))

/** Sin remitente configurado, el modelo ni siquiera ve la herramienta de correo real. */
function definicionesPara(remitente?: Remitente): DefinicionHerramienta[] {
  return remitente ? todas : todas.filter((d) => d.nombre !== "proveedor_enviar_correo")
}

/** Quita del prompt la sección de copia por correo cuando esa herramienta no está disponible. */
function sinSeccionCorreo(prompt: string): string {
  return prompt.replace(/\n## Copia por correo[\s\S]*?(?=\n## |$)/, "\n")
}

/** System prompt = comportamiento (agent/prompt.md) + conocimiento (src/knowledge/registro-proveedor.md). */
async function systemPrompt(raiz: string, conCorreo: boolean): Promise<string> {
  const [prompt, conocimiento] = await Promise.all([
    readFile(path.join(raiz, "agent", "prompt.md"), "utf8"),
    readFile(path.join(raiz, "src", "knowledge", "registro-proveedor.md"), "utf8"),
  ])
  return `${conCorreo ? prompt : sinSeccionCorreo(prompt)}\n\n---\n\n# Conocimiento del proceso\n\n${conocimiento}`
}

/** Oculta valores bancarios y números largos en lo que se muestra en el chat. */
export function enmascarar(valor: unknown, clavesBancarias: string[] = []): unknown {
  const ocultar = (dato: unknown): unknown => {
    if (Array.isArray(dato)) return dato.map(ocultar)
    if (typeof dato === "object" && dato !== null) {
      const registro = dato as Record<string, unknown>
      const etiqueta = typeof registro.etiqueta === "string" ? registro.etiqueta.toLowerCase() : ""
      const esBancario = /banco|cuenta|swift|iban|bic/.test(etiqueta)
      return Object.fromEntries(Object.entries(registro).map(([clave, contenido]) => [
        clave,
        esBancario && clave === "valor" ? "(dato bancario oculto)" : clavesBancarias.some((bancaria) => clave === bancaria || clave.startsWith(`${bancaria}.`)) ? "(dato bancario oculto)" : ocultar(contenido),
      ]))
    }
    return typeof dato === "string" ? dato.replace(/\b\d{6,}(\d{4})\b/g, "******$1") : dato
  }
  return ocultar(valor)
}

function casoDe(args: unknown): string | undefined {
  const caso = (args as { caso?: unknown } | null)?.caso
  return typeof caso === "string" ? caso : undefined
}

function casoSolicitado(texto: string): string | undefined {
  return texto.match(/\b(?:co-industrias-delta|ec-corp-andina|hn-agroexport-sula|pa-logistica-istmo)\b/i)?.[0]?.toLowerCase()
}

function pendientePrevioDesdeVigente(sesion: Sesion): boolean {
  return sesion.pendienteDesde !== undefined && Date.now() - sesion.pendienteDesde < VIGENCIA_CONFIRMACION_MS
}

async function ejecutarLlamada(sesion: Sesion, llamada: LlamadaHerramienta, raiz: string, remitente?: Remitente): Promise<{ contenido: string; visible: ToolCallVisible }> {
  const herramienta = buscarHerramienta(llamada.nombre)
  const contenido = herramienta
    ? await herramienta.ejecutar(llamada.args, { directory: raiz, sessionId: sesion.id, remitente })
    : JSON.stringify({ ok: false, error: `herramienta desconocida: ${llamada.nombre}` })
  const r = JSON.parse(contenido) as { ok: boolean; error?: string; data?: { resumen?: string; listo_para_firma?: boolean } }
  const caso = casoDe(llamada.args)
  // Solo un paquete listo puede esperar confirmación de envío.
  if (caso && ((llamada.nombre === "proveedor_armar_paquete" && r.ok && r.data?.listo_para_firma === true) || (llamada.nombre === "proveedor_simular_envio" && !r.ok && r.error === "requiere confirmación explícita"))) {
    sesion.pendiente = caso
    sesion.pendienteDesde = Date.now()
  }
  // Si el envío real falló por algo reintentable, se vuelve a mostrar el campo de correo.
  if (llamada.nombre === "proveedor_enviar_correo" && !r.ok && !/límite|máximo|dominios/.test(r.error ?? "")) sesion.ofrecerCorreo = true
  if (llamada.nombre === "proveedor_simular_envio" && r.ok) {
    sesion.pendiente = undefined
    sesion.ofrecerCorreo = true
  }
  const reglas = await leerReglas(raiz).catch(() => undefined)
  const visible = { nombre: llamada.nombre, args: enmascarar(llamada.args, reglas?.claves_bancarias), ok: r.ok, resumen: r.ok ? r.data?.resumen ?? "ok" : r.error ?? "error" }
  return { contenido, visible }
}

/** CA3/RN4: solo el mensaje inmediatamente posterior a la pregunta puede confirmar. */
function procesarConfirmacion(sesion: Sesion, texto: string): void {
  revocarPermisos(sesion.id)
  // Una conversación retomada horas después no confirma un envío viejo.
  const vigente = sesion.pendienteDesde !== undefined && Date.now() - sesion.pendienteDesde < VIGENCIA_CONFIRMACION_MS
  if (sesion.pendiente && vigente && esConfirmacion(texto)) otorgarConfirmacion(sesion.id, sesion.pendiente)
  // HU-7: el único destinatario válido es el correo que el usuario escribió en este mensaje.
  const correo = correoDelMensaje(texto)
  if (correo) otorgarPermiso(sesion.id, "correo", correo)
  sesion.pendiente = undefined
}

function mensajeTope(toolCalls: ToolCallVisible[], porTokens: boolean): string {
  const hechos = toolCalls.map((t) => `- ${t.nombre}: ${t.resumen}`).join("\n")
  const motivo = porTokens
    ? `Esta sesión alcanzó el tope de ${config.maxTokensSesion} tokens.`
    : `Alcancé el tope de ${config.maxIter} pasos en este turno.`
  const siguiente = porTokens ? "Abre una sesión nueva para continuar." : "Falta completar el resto; pídeme continuar."
  return `${motivo} Esto es lo que logré:\n${hechos || "- nada todavía"}\n\n${siguiente}`
}

export async function ejecutarTurno(sesion: Sesion, texto: string, llm: LlmAdapter, raiz: string, remitente?: Remitente): Promise<RespuestaTurno> {
  const ts = new Date().toISOString()
  sesion.historial.push({ rol: "user", texto, ts })
  const toolCalls: ToolCallVisible[] = []
  let paquetePreparado: { listo_para_firma?: boolean; checklist?: { faltantes?: string[]; soportes?: { tipo: string; estado: string }[] } } | undefined
  let reply = ""
  sesion.ofrecerCorreo = false

  if (sesion.tokens >= config.maxTokensSesion) {
    reply = `Esta sesión alcanzó el tope de ${config.maxTokensSesion} tokens. Abre una sesión nueva para continuar.`
  } else {
    const pendientePrevio = sesion.pendiente
    const confirmacionValida = Boolean(pendientePrevio && pendientePrevioDesdeVigente(sesion) && esConfirmacion(texto))
    procesarConfirmacion(sesion, texto)
    sesion.mensajes.push({ rol: "user", texto })
    if (confirmacionValida && pendientePrevio) {
      const llamada = { id: `servidor_proveedor_simular_envio_${Date.now()}`, nombre: "proveedor_simular_envio", args: { caso: pendientePrevio, confirmado: true } }
      const { contenido, visible } = await ejecutarLlamada(sesion, llamada, raiz, remitente)
      sesion.mensajes.push({ rol: "tool", id: llamada.id, nombre: llamada.nombre, contenido })
      toolCalls.push(visible)
      reply = visible.ok ? `Envío simulado generado en ${visible.resumen.replace(/^envío simulado en /, "")}.` : visible.resumen
    } else if (pendientePrevio && esConfirmacion(texto)) {
      reply = "La confirmación del paquete caducó. Procesa nuevamente el caso antes de solicitar el envío."
    } else if (!pendientePrevio && esConfirmacion(texto)) {
      reply = "No hay un paquete listo pendiente de confirmación. Procesa un caso antes de solicitar el envío."
    }
    if (!pendientePrevio && /^\s*env/i.test(texto)) {
      reply = "No hay un paquete listo pendiente de confirmación. No se ejecutó ningún envío."
    }
    const caso = casoSolicitado(texto)
    if (caso) {
      const secuencia = [
        { nombre: "proveedor_leer_solicitud", args: { caso } },
        { nombre: "proveedor_mapear_campos", args: { caso, campos: [] } },
        { nombre: "proveedor_generar_formulario", args: { caso } },
        { nombre: "proveedor_armar_paquete", args: { caso } },
      ]
      for (const paso of secuencia) {
        const llamada = { id: `servidor_${paso.nombre}_${Date.now()}`, ...paso }
        const { contenido, visible } = await ejecutarLlamada(sesion, llamada, raiz, remitente)
        sesion.mensajes.push({ rol: "tool", id: llamada.id, nombre: llamada.nombre, contenido })
        toolCalls.push(visible)
        if (paso.nombre === "proveedor_armar_paquete" && visible.ok) {
          const resultadoPaquete = JSON.parse(contenido) as { data?: typeof paquetePreparado }
          paquetePreparado = resultadoPaquete.data
        }
        if (!visible.ok) break
      }
      const listo = paquetePreparado?.listo_para_firma === true
      if (listo) {
        sesion.pendiente = caso
        sesion.pendienteDesde = Date.now()
        reply = `El paquete de ${caso} quedó listo para firma. Revisa el checklist. ¿Confirmas simular el envío?`
      } else {
        const faltantes = paquetePreparado?.checklist?.faltantes ?? []
        const bloqueos = paquetePreparado?.checklist?.soportes?.filter((soporte) => soporte.estado === "ausente" || soporte.estado === "vencido").map((soporte) => `${soporte.tipo} (${soporte.estado})`) ?? []
        reply = `El paquete de ${caso} quedó preparado, pero no está listo para firma. Corrige: ${[...bloqueos, ...faltantes].join(", ") || "los hallazgos del checklist"}. No se habilitó ningún envío.`
      }
    } else if (!reply) try {
      const system: Mensaje = { rol: "system", texto: await systemPrompt(raiz, Boolean(remitente)) }
      let terminado = false
      for (let i = 0; i < config.maxIter && !terminado; i++) {
        const r = await llm.enviar([system, ...sesion.mensajes], definicionesPara(remitente))
        sesion.tokens += r.tokens
        sesion.mensajes.push({ rol: "assistant", texto: r.texto, llamadas: r.llamadas })
        if (r.llamadas.length === 0) {
          reply = r.texto
          terminado = true
          break
        }
        for (const llamada of r.llamadas) {
          const { contenido, visible } = await ejecutarLlamada(sesion, llamada, raiz, remitente)
          sesion.mensajes.push({ rol: "tool", id: llamada.id, nombre: llamada.nombre, contenido })
          toolCalls.push(visible)
        }
        if (sesion.tokens >= config.maxTokensSesion) break
      }
      if (!terminado) reply = mensajeTope(toolCalls, sesion.tokens >= config.maxTokensSesion)
    } catch (e) {
      // CA5: el error se muestra en claro y la sesión sigue viva.
      const motivo = e instanceof Error && e.name.includes("Timeout") ? "el modelo tardó demasiado en responder" : mensajeDeError(e)
      reply = `No pude completar la respuesta porque falló la conexión con el modelo (${motivo}). La sesión sigue activa: intenta de nuevo.`
    }
  }
  revocarPermisos(sesion.id)
  const needsConfirmation = Boolean(sesion.pendiente)
  const pideCorreo = Boolean(remitente && sesion.ofrecerCorreo)
  sesion.historial.push({ rol: "assistant", texto: reply, ts: new Date().toISOString(), toolCalls, needsConfirmation })
  return { reply, toolCalls, needsConfirmation, pideCorreo }
}
