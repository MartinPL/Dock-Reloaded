import GObject from "gi://GObject"
import GLib from "gi://GLib"
import Meta from "gi://Meta"
import Shell from "gi://Shell"
import Clutter from "gi://Clutter"
import * as Main from "resource:///org/gnome/shell/ui/main.js"
import * as Dash from "resource:///org/gnome/shell/ui/dash.js"
import * as AppFavorites from "resource:///org/gnome/shell/ui/appFavorites.js"
import * as Layout from "resource:///org/gnome/shell/ui/layout.js"

const Dock = GObject.registerClass(
    class Dock extends Dash.Dash {
        _init(monitor) {
            super._init()
            Main.layoutManager.addTopChrome(this)
            this._showAppsIcon.showLabel = DockItemContainer.prototype.showLabel
            this.showAppsButton.connect("button-release-event", this._showAppsToggle.bind())
            this.set_track_hover(true)
            this.set_reactive(true)
            this.hide()

            this._monitor = monitor
            this.set_width(this._monitor.width)
            this.set_position(this._monitor.x, 0)
            this.set_style_class_name("dock")

            this._dragging = false
            this._itemDragBeginSignal = Main.overview.connect("item-drag-begin", () => {
                this._dragging = true
            })
            this._itemDragEndSignal = Main.overview.connect("item-drag-end", () => {
                this._dragging = false
            })

            this._pressureBarrier = new Layout.PressureBarrier(250, 1000, Shell.ActionMode.NORMAL)
            this._barrier = this._createBarrier()
            this._pressureBarrier.addBarrier(this._barrier)
            this._pressureBarrier.connect("trigger", () => this._revealDock(true))

            this.connect("destroy", this._onDestroy.bind(this))
        }

        _showAppsToggle() {
            if (Main.overview.visible) {
                Main.overview.hide()
            } else {
                Main.overview.showApps()
            }
        }

        _revealDock() {
            this.show()

            this._revealTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 550, () => {
                if (!this._dragging && !this.get_hover() && global.display.get_focus_window()) {
                    this.hide()
                    return GLib.SOURCE_REMOVE
                } else {
                    return GLib.SOURCE_CONTINUE
                }
            })
        }

        _createBarrier() {
            return new Meta.Barrier({
                backend: global.backend,
                x1: this._monitor.x,
                x2: this._monitor.x + this._monitor.width,
                y1: 0,
                y2: 0,
                directions: Meta.BarrierDirection.POSITIVE_Y,
            })
        }

        _createAppItem(app) {
            let appIcon = new Dash.DashIcon(app)

            appIcon.connect("menu-state-changed", (o, opened) => {
                this._itemMenuStateChanged(item, opened)
            })

            let item = new DockItemContainer()
            item.setChild(appIcon)

            appIcon.label_actor = null
            item.setLabelText(app.get_name())

            appIcon.icon.setIconSize(this.iconSize)
            this._hookUpLabel(item, appIcon)

            return item
        }

        // Copycat from GS without running apps and separator
        _redisplay() {
            let favorites = AppFavorites.getAppFavorites().getFavoriteMap()
            let children = this._box.get_children().filter((actor) => {
                return actor.child && actor.child._delegate && actor.child._delegate.app
            })
            let oldApps = children.map((actor) => actor.child._delegate.app)
            let newApps = []

            for (let id in favorites) newApps.push(favorites[id])

            let addedItems = []
            let removedActors = []

            let newIndex = 0
            let oldIndex = 0
            while (newIndex < newApps.length || oldIndex < oldApps.length) {
                let oldApp = oldApps.length > oldIndex ? oldApps[oldIndex] : null
                let newApp = newApps.length > newIndex ? newApps[newIndex] : null

                if (oldApp == newApp) {
                    oldIndex++
                    newIndex++
                    continue
                }

                if (oldApp && !newApps.includes(oldApp)) {
                    removedActors.push(children[oldIndex])
                    oldIndex++
                    continue
                }

                if (newApp && !oldApps.includes(newApp)) {
                    addedItems.push({
                        app: newApp,
                        item: this._createAppItem(newApp),
                        pos: newIndex,
                    })
                    newIndex++
                    continue
                }

                let nextApp = newApps.length > newIndex + 1 ? newApps[newIndex + 1] : null
                let insertHere = nextApp && nextApp == oldApp
                let alreadyRemoved = removedActors.reduce((result, actor) => {
                    let removedApp = actor.child._delegate.app
                    return result || removedApp == newApp
                }, false)

                if (insertHere || alreadyRemoved) {
                    let newItem = this._createAppItem(newApp)
                    addedItems.push({
                        app: newApp,
                        item: newItem,
                        pos: newIndex + removedActors.length,
                    })
                    newIndex++
                } else {
                    removedActors.push(children[oldIndex])
                    oldIndex++
                }
            }

            for (let i = 0; i < addedItems.length; i++) {
                this._box.insert_child_at_index(addedItems[i].item, addedItems[i].pos)
            }

            for (let i = 0; i < removedActors.length; i++) {
                let item = removedActors[i]

                if (Main.overview.visible && !Main.overview.animationInProgress) item.animateOutAndDestroy()
                else item.destroy()
            }

            this._adjustIconSize()

            let animate = this._shownInitially && Main.overview.visible && !Main.overview.animationInProgress

            if (!this._shownInitially) this._shownInitially = true

            for (let i = 0; i < addedItems.length; i++) addedItems[i].item.show(animate)

            this._box.queue_relayout()
        }

        _onDestroy() {
            this._pressureBarrier.destroy()
            this._pressureBarrier = null
            this._barrier.destroy()
            this._barrier = null

            if (this._revealTimeout) {
                GLib.Source.remove(this._revealTimeout)
                this._revealTimeout = null
            }

            if (this._itemDragBeginSignal) {
                Main.overview.disconnect(this._itemDragBeginSignal)
                this._itemDragBeginSignal = null
            }

            if (this._itemDragEndSignal) {
                Main.overview.disconnect(this._itemDragEndSignal)
                this._itemDragEndSignal = null
            }
        }
    }
)

const DockItemContainer = GObject.registerClass(
    class DockItemContainer extends Dash.DashItemContainer {
        showLabel() {
            if (!this._labelText) return

            this.label.set_text(this._labelText)
            this.label.opacity = 0
            this.label.show()

            let [stageX, stageY] = this.get_transformed_position()

            const itemWidth = this.allocation.get_width()

            const labelWidth = this.label.get_width()
            const xOffset = Math.floor((itemWidth - labelWidth) / 2)
            const x = Math.clamp(stageX + xOffset, 0, global.stage.width - labelWidth)

            const y = this.get_height() + stageY

            this.label.set_position(x, y)
            this.label.ease({
                opacity: 255,
                duration: Dash.DASH_ITEM_LABEL_SHOW_TIME,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            })
        }
    }
)

export default class DockReloaded {
    enable() {
        Main.overview.dash.hide()
        this.docks = []
        Main.layoutManager.monitors.forEach((monitor) => {
            this.docks.push(new Dock(monitor))
        })
        this._monitorChangedSignal = Main.layoutManager.connect("monitors-changed", this._onMonitorsChanged.bind(this))
    }

    _onMonitorsChanged() {
        this.disable()
        this.enable()
    }

    disable() {
        Main.overview.dash.show()
        this.docks.forEach((dock) => {
            dock.destroy()
        })
        this.docks = []

        if (this._monitorChangedSignal) {
            Main.layoutManager.disconnect(this._monitorChangedSignal)
            this._monitorChangedSignal = null
        }
    }
}
