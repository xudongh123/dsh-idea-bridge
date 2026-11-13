/**
 * dsh-idea-bridge — Browser half.
 *
 * 1. "在 IDEA 中打开" on every `file` context menu (chat file references, the
 *    workspace file tree, and the changed-files card, which already exposes
 *    `{ kind: 'file', value: { sessionId, path } }` as its target).
 * 2. The draft inbox: the Host parks a selection (quote) or a whole-file
 *    reference, this claims it and puts it in the composer *as a chip*, not as
 *    sent text and not as a plain text blob.
 * 3. "引用整个文件" on each changed-files card, which parks an `@` reference
 *    for the whole file so it can be quoted into the composer.
 *
 * A throwing apply() replaces the whole app with "Failed to load plugins", so
 * every failure path here reports and returns instead of propagating.
 */
window.__ModuleLoader__.load({
	id: 'dsh-idea-bridge',
	factory: (require) => {
		var PREFIX = '/dsh-idea'

		function post(path, body) {
			return window
				.fetch(PREFIX + path, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify(body),
				})
				.then(function (response) {
					return response.json()
				})
				.then(function (payload) {
					if (payload === null || typeof payload !== 'object' || payload.ok !== true) {
						throw new Error(payload !== null && typeof payload === 'object' ? String(payload.error) : 'request failed')
					}
					return payload
				})
		}

		/** Resolve a workspace-relative path to the absolute path IDEA needs. */
		function absolutePath(ctx, target, signal) {
			var path = typeof target.path === 'string' ? target.path : ''
			if (path.startsWith('/')) return Promise.resolve(path)
			var remote = ctx.get('remote')
			var stat = remote !== undefined && remote.workspaceFiles !== undefined ? remote.workspaceFiles.stat : undefined
			if (typeof stat !== 'function') return Promise.resolve('')
			return Promise.resolve(stat(target.sessionId, path, signal)).then(
				function (result) {
					return result !== null && typeof result === 'object' && result.ok === true && result.value !== null && typeof result.value === 'object'
						? String(result.value.absolutePath ?? '')
						: ''
				},
				function () {
					return ''
				},
			)
		}

		/**
		 * The composer shell for a session. `conversation.input` is the InputHub;
		 * `for(actx)` returns the shell whose `insertReference(ref, span)` turns a
		 * reference into a real chip node (the actions object does not expose it).
		 */
		function composerShell(ctx, sessionId) {
			try {
				var sessions = ctx.get('sessions')
				var conversation = ctx.get('conversation')
				if (sessions === undefined || conversation === undefined) return undefined
				var hub = conversation.input
				if (hub === undefined || typeof hub.for !== 'function') return undefined
				var actx = sessions.scope(sessionId)
				if (actx === undefined) return undefined
				var shell = hub.for(actx)
				return shell !== undefined && typeof shell.insertReference === 'function' ? shell : undefined
			} catch (error) {
				return undefined
			}
		}

		/** Insert a real `@path` reference chip at the caret. */
		function insertReferenceChip(ctx, sessionId, path, label) {
			try {
				var shell = composerShell(ctx, sessionId)
				if (shell === undefined) return false
				var ref = {
					source: 'reference',
					ref: '@' + path,
					label: typeof label === 'string' && label.length > 0 ? label : path,
					appearance: 'file',
					clipboardText: '@' + path,
				}
				return shell.insertReference(ref, shell.actions.captureInsertion()) === true
			} catch (error) {
				console.error('dsh-idea-bridge: could not insert the reference', error)
				return false
			}
		}

		/**
		 * Last resort when the composer refuses a chip (session sending, editor
		 * not mounted): put the text in at the caret, then replace the draft.
		 */
		function fillComposer(inputActions, text) {
			try {
				if (typeof inputActions.insertText === 'function' && typeof inputActions.captureInsertion === 'function') {
					if (inputActions.insertText(text, inputActions.captureInsertion()) === true) {
						if (typeof inputActions.persistDraft === 'function') inputActions.persistDraft()
						return true
					}
				}
				if (typeof inputActions.setDraft === 'function') {
					inputActions.setDraft(text)
					if (typeof inputActions.persistDraft === 'function') inputActions.persistDraft()
					return true
				}
			} catch (error) {
				console.error('dsh-idea-bridge: could not fill the composer', error)
			}
			return false
		}

		/**
		 * A selection becomes a single `@path` chip labelled `file:lines` — just the
		 * reference tag, no pasted code. Only when the file cannot become a chip
		 * (outside the workspace, or no composer shell) does the code travel as text,
		 * because otherwise the selection would be lost silently.
		 */
		function applySelection(ctx, inputActions, sessionId, draft) {
			var anchor = typeof draft.anchor === 'string' ? draft.anchor : ''
			var code = typeof draft.text === 'string' ? draft.text : ''
			var path = typeof draft.path === 'string' && draft.path.length > 0 ? draft.path : undefined
			if (path !== undefined) {
				if (insertReferenceChip(ctx, sessionId, path, anchor.length > 0 ? anchor : path)) {
					if (typeof inputActions.persistDraft === 'function') inputActions.persistDraft()
					return true
				}
				return fillComposer(inputActions, '@' + path + ' ')
			}
			return fillComposer(inputActions, (anchor.length > 0 ? anchor + '\n' : '') + '```\n' + code + '\n```')
		}

		/** Apply one parked draft; returns false when the composer refused it. */
		function applyDraft(ctx, inputActions, sessionId, draft) {
			if (draft === null || typeof draft !== 'object') return true
			if (draft.kind === 'reference' && typeof draft.path === 'string' && draft.path.length > 0) {
				if (insertReferenceChip(ctx, sessionId, draft.path, draft.label)) {
					if (typeof inputActions.persistDraft === 'function') inputActions.persistDraft()
					return true
				}
				return fillComposer(inputActions, '@' + draft.path + ' ')
			}
			if (draft.kind === 'selection') return applySelection(ctx, inputActions, sessionId, draft)
			var text = typeof draft.text === 'string' ? draft.text : ''
			if (text.length === 0) return true
			return fillComposer(inputActions, text)
		}

		/**
		 * Claims drafts the Host parked for this session and drops them into the
		 * composer. Renders nothing; it rides in the session header actions slot
		 * because that slot receives both `sessionId` and `inputActions`.
		 */
		function makeDraftInbox(React, ctx) {
			var attempts = {}

			return function DraftInbox(props) {
				var sessionId = props.sessionId
				var inputActions = props.inputActions

				React.useEffect(
					function () {
						if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined
						if (inputActions === undefined || inputActions === null) return undefined
						var stopped = false
						var busy = false

						function claim() {
							if (stopped || busy) return
							busy = true
							post('/pending', { sessionId: sessionId })
								.then(function (payload) {
									if (stopped) return
									var draft = payload.draft
									if (draft === null || draft === undefined) return
									if (applyDraft(ctx, inputActions, sessionId, draft)) {
										attempts[sessionId] = 0
										return
									}
									// Hand it back so a later poll can retry, but do not
									// spin forever against a session that cannot take it.
									attempts[sessionId] = (attempts[sessionId] ?? 0) + 1
									if (attempts[sessionId] <= 3) {
										post('/repark', { sessionId: sessionId, draft: draft }).catch(function () {})
									}
								})
								.catch(function () {})
								.then(function () {
									busy = false
								})
						}

						var timer = window.setInterval(claim, 1200)
						return function () {
							stopped = true
							window.clearInterval(timer)
						}
					},
					[sessionId, inputActions],
				)

				return null
			}
		}

		/**
		 * A changed-files card action. The slot only hands over `actionUrl`
		 * (`/api/present.open?sessionId&seq&index`); the Host resolves the file
		 * path from that triple and parks the reference.
		 */
		function makeCardAction(React) {
			return function CardAction(props) {
				var state = React.useState('idle')
				var status = state[0]
				var setStatus = state[1]

				function click() {
					var url = typeof props.actionUrl === 'string' ? props.actionUrl : ''
					var query = url.indexOf('?') >= 0 ? url.slice(url.indexOf('?') + 1) : ''
					var params = new URLSearchParams(query)
					var sessionId = params.get('sessionId')
					var seq = params.get('seq')
					var index = params.get('index')
					if (sessionId === null || seq === null || index === null) return
					setStatus('busy')
					var source = url.indexOf('changes.open') >= 0 ? 'changes' : 'presented'
					post('/card', { sessionId: sessionId, seq: Number(seq), index: Number(index), source: source })
						.then(function () {
							setStatus('done')
							window.setTimeout(function () {
								setStatus('idle')
							}, 1800)
						})
						.catch(function () {
							setStatus('error')
							window.setTimeout(function () {
								setStatus('idle')
							}, 2400)
						})
				}

				var label =
					status === 'busy'
						? '引用中…'
						: status === 'done'
							? '已放入输入框'
							: status === 'error'
								? '失败，重试'
								: '引用整个文件'

				return React.createElement(
					'button',
					{
						type: 'button',
						onClick: click,
						disabled: status === 'busy' || props.available === false || props.pending === true,
						title: '把整个文件作为 @ 引用放进 DSH 输入框',
						style: {
							background: 'transparent',
							border: '1px solid rgba(128,128,128,.4)',
							borderRadius: 6,
							padding: '2px 8px',
							fontSize: 12,
							lineHeight: '18px',
							color: 'inherit',
							fontFamily: 'inherit',
							cursor: 'pointer',
							opacity: props.available === false ? 0.5 : 1,
						},
					},
					label,
				)
			}
		}

		function apply(ctx) {
			try {
				var menus = ctx.get('contextMenus')
				if (menus !== undefined && typeof menus.register === 'function') {
					ctx.effect(
						function () {
							return menus.register({
								id: 'dsh-idea-bridge.file',
								target: 'file',
								order: 500,
								resolve: function (target, signal) {
									if (target === null || typeof target !== 'object') return []
									return absolutePath(ctx, target, signal).then(function (absolute) {
										if (absolute.length === 0) return []
										var relative = typeof target.path === 'string' ? target.path : ''
										var items = [
											{
												id: 'open-in-idea',
												label: '在 IDEA 中打开',
												failureLabel: '无法在 IDEA 中打开该文件',
												run: function () {
													return post('/open', { file: absolute })
												},
											},
										]
										if (relative.length > 0) {
											items.push({
												id: 'reference-in-chat',
												label: '引用整个文件到对话',
												failureLabel: '无法把该文件放进输入框',
												run: function () {
													return post('/card', { sessionId: target.sessionId, path: relative })
												},
											})
										}
										return items
									})
								},
							})
						},
						'dsh-idea-bridge: file context menu',
					)
				}

				var slots = ctx.get('slots')
				if (slots === undefined || typeof slots.inject !== 'function') return
				var React = require('react')

				var DraftInbox = makeDraftInbox(React, ctx)
				ctx.effect(
					function () {
						return slots.inject('conversation.session.header.actions', function () {
							return slots.register(
								{ name: 'conversation.session.header.actions', id: 'dsh-idea-bridge.draft', order: 900 },
								DraftInbox,
							)
						})
					},
					'dsh-idea-bridge: draft inbox',
				)

				var CardAction = makeCardAction(React)
				var cardSlots = ['deliverables.file.actions', 'deliverables.review.file.actions']
				for (var at = 0; at < cardSlots.length; at += 1) {
					;(function (slotName) {
						ctx.effect(
							function () {
								return slots.inject(slotName, function () {
									return slots.register(
										{ name: slotName, id: 'dsh-idea-bridge.card', order: 40 },
										CardAction,
									)
								})
							},
							'dsh-idea-bridge: card action (' + slotName + ')',
						)
					})(cardSlots[at])
				}
			} catch (error) {
				console.error('dsh-idea-bridge: apply failed', error)
			}
		}

		return { inject: ['contextMenus', 'slots'], apply: apply }
	},
})
