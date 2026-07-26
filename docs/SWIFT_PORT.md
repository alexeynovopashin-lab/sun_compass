# Переход на Xcode и Swift

План порта «Солнечного компаса» из PWA в нативное приложение iOS.
Актуально для версии 2.0.0.

## Какой путь выбрать

| Путь | Суть | Оценка |
|---|---|---|
| **A. Обёртка WKWebView** | `index.html` внутри нативного контейнера | Быстро (1–2 дня), но App Store отклоняет приложения, которые «просто сайт» (Guideline 4.2). Главное — в WKWebView **нет** `webkitCompassHeading`: компас придётся всё равно писать нативно и пробрасывать в JS через `WKScriptMessageHandler`. Половина работы нативной версии — ради худшего результата |
| **B. Нативный SwiftUI** ✅ | Логика переносится в Swift, кольцо рисуется в `Canvas` | 1–2 недели. Настоящий доступ к `CLLocationManager` и `CMMotionManager`, компенсация наклона, виджеты, Live Activity, работа без сети из коробки |

**Рекомендация — путь B.** Приложение маленькое (около 1200 строк, из них треть — встроенный SunCalc),
логика чистая и уже разбита на секции. PWA при этом остаётся жить: это витрина и бета-канал.

## Структура проекта

```
SunCompass/
├── SunCompassApp.swift            @main, сцена
├── Models/
│   ├── SunCalc.swift              порт астрономии (getPosition, getTimes)
│   ├── SunPhase.swift             пороги высоты, названия, цвета
│   ├── SunPath.swift              выборка суток, полярная проекция
│   └── SolarPassage.swift         обратная задача: азимут → время
├── Services/
│   ├── HeadingService.swift       CLLocationManager: курс и координаты
│   └── GeocodingService.swift     CLGeocoder вместо photon.komoot.io
├── Views/
│   ├── CompassView.swift          кольцо: деления, буквы, траектория, точки
│   ├── SunPathShape.swift         Canvas-отрисовка градиентной дуги
│   ├── OdometerView.swift         барабаны часов
│   ├── ShutterButton.swift        кнопка спуска
│   └── RootView.swift             компоновка и zoom-режим
├── ViewModels/
│   └── CompassViewModel.swift     машина состояний, замер, сброс
└── Resources/
    └── Assets.xcassets            иконка из icon.svg
```

## Карта переноса

| JS в `index.html` | Swift |
|---|---|
| `SunCalc.getPosition` | `SunCalc.position(date:lat:lon:) -> (azimuth: Double, altitude: Double)` |
| `SunCalc.getTimes` | `SunCalc.times(date:lat:lon:) -> SunTimes` (структура вместо словаря) |
| `SUN_PHASES` | `enum SunPhase: CaseIterable` с `minAltitude`, `title`, `color` |
| `PATH_COLOR_STOPS` | `struct PathStop` + `static let stops: [PathStop]` |
| `altitudeToRadius` | `func radius(forAltitude:) -> CGFloat` |
| `buildSunPathSamples` | `SunPath.samples(lat:lon:on:) -> [SunSample]` |
| `renderSunPath` | `Canvas { ctx, size in ... }` — рисуем `Path` по прогонам |
| `findSolarPassage` | `SolarPassage.find(azimuth:lat:lon:from:) -> Date?`, выносится в `Task.detached` |
| `handleOrientation` | `CLLocationManagerDelegate.didUpdateHeading` |
| `smoothAngle` (lerp 0.15) | `withAnimation(.interpolatingSpring)` или тот же lerp в `TimelineView` |
| `renderCompass` (rAF) | `TimelineView(.animation)` |
| Одометр на `translateY(em)` | `OdometerView` с `.offset(y:)` и `.animation(.timingCurve)` |
| `safeStorage` | `@AppStorage` |
| `localStorage` кэш города | `UserDefaults` |
| Service Worker | не нужен: нативное приложение офлайн по определению |
| `visibilitychange`, сторож `finishStory` | не нужны: `Task` не замораживается как `rAF` |

## Астрономия

SunCalc переносится напрямую — это чистые формулы без состояния, около 60 строк.
Псевдокод ядра:

```swift
enum SunCalc {
    private static let rad = Double.pi / 180
    private static let obliquity = rad * 23.4397
    private static let J1970 = 2_440_588.0
    private static let J2000 = 2_451_545.0

    static func days(_ date: Date) -> Double {
        date.timeIntervalSince1970 / 86_400 - 0.5 + J1970 - J2000
    }

    static func position(_ date: Date, lat: Double, lon: Double)
        -> (azimuth: Double, altitude: Double) {
        let lw = rad * -lon
        let phi = rad * lat
        let d = days(date)
        let c = sunCoords(d)
        let H = siderealTime(d, lw) - c.rightAscension
        // Азимут приводится к навигационной шкале: 0° = север, по часовой стрелке
        let az = atan2(sin(H), cos(H) * sin(phi) - tan(c.declination) * cos(phi))
        let alt = asin(sin(phi) * sin(c.declination)
                     + cos(phi) * cos(c.declination) * cos(H))
        return ((az / rad + 180).truncatingRemainder(dividingBy: 360), alt / rad)
    }
}
```

Обязательно перенесите и **тесты сходимости**: для набора городов (Москва, Сидней, Шпицберген,
Сингапур, Ушуая) азимут и высота из Swift должны совпадать с JS-версией с точностью до 0.01°.
Это самая простая и самая ценная страховка при порте.

## Кольцо на Canvas

Полярная формула не меняется:

```swift
func point(azimuth: Double, radius: CGFloat, center: CGPoint) -> CGPoint {
    let angle = (azimuth - 90) * .pi / 180
    return CGPoint(x: center.x + radius * cos(angle),
                   y: center.y + radius * sin(angle))
}
```

Логика прогонов из `renderSunPath` переносится дословно: тот же порог по разнице RGB,
тот же разрыв на границе «прошлое / будущее», та же интерполяция толщины. В `Canvas`
каждый прогон — `ctx.stroke(path, with: .color(...), style: StrokeStyle(lineWidth:lineCap:.round))`.

Вращение диска — `.rotationEffect(.degrees(-heading))` на всём слое кольца.

## Датчики

`CLLocationManager` даёт и координаты, и курс — `CMMotionManager` отдельно не нужен,
пока не понадобится компенсация наклона.

```swift
final class HeadingService: NSObject, ObservableObject, CLLocationManagerDelegate {
    @Published var heading: Double = 0
    @Published var coordinate: CLLocationCoordinate2D?

    private let manager = CLLocationManager()

    func start() {
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyBest
        manager.headingFilter = 1          // градус
        manager.requestWhenInUseAuthorization()
        manager.startUpdatingLocation()
        if CLLocationManager.headingAvailable() { manager.startUpdatingHeading() }
    }

    func locationManager(_ m: CLLocationManager, didUpdateHeading h: CLHeading) {
        guard h.headingAccuracy >= 0 else { return }   // отрицательная = данные негодные
        heading = h.trueHeading >= 0 ? h.trueHeading : h.magneticHeading
    }
}
```

Три вещи, которых не было в вебе и которые надо не забыть:

1. `trueHeading` доступен только при работающих службах геолокации; иначе `magneticHeading`.
2. `headingAccuracy < 0` означает, что датчик не откалиброван — это честный повод показать
   «Калибровка…» вместо самодельной проверки разброса по истории (`isHeadingStable`).
3. `manager.headingOrientation` надо синхронизировать с ориентацией интерфейса,
   иначе получите ту же ошибку на 90°, что чинилась в вебе поправкой `screen.orientation.angle`.

**Компенсация наклона** — то, ради чего стоит идти в натив. Через `CMDeviceMotion.attitude`
можно считать азимут не только для телефона «экраном вверх», но и для вертикального положения,
как в видоискателе камеры. Это снимает главное текущее ограничение (см. ARCHITECTURE.md).

## Геокодер

`photon.komoot.io` заменяется на `CLGeocoder.reverseGeocodeLocation` — без сетевого запроса
к чужому сервису и без вопросов о приватности при ревью App Store.

## Info.plist и настройки таргета

| Ключ | Значение |
|---|---|
| `NSLocationWhenInUseUsageDescription` | «Координаты нужны, чтобы рассчитать положение солнца в вашей точке. Они не покидают устройство.» |
| `UISupportedInterfaceOrientations` | только `Portrait` — как `orientation: portrait` в манифесте |
| `UIUserInterfaceStyle` | `Dark` — интерфейс всегда тёмный |
| `UIStatusBarStyle` | `LightContent` |

- Deployment target: iOS 17 (нужен `Canvas` и `TimelineView` без оговорок).
- Bundle ID: `com.novopashin.suncompass` (или ваш префикс).
- Иконка: `icon.svg` → экспорт в 1024×1024 PNG без прозрачности (App Store не принимает альфа-канал).

## Порядок работ

1. `SunCalc.swift` + тесты сходимости с JS. Пока это не сошлось, дальше идти нет смысла.
2. `SunPhase.swift`, `SunPath.swift` — модель без единого элемента интерфейса.
3. `CompassView` со статичным кольцом и траекторией на заданные координаты и дату.
4. `HeadingService`, живое вращение.
5. `SolarPassage.find`, ролик замера, состояния.
6. `OdometerView` — самая трудоёмкая часть интерфейса, оставить на конец.
7. Zoom-режим, онбординг, экран разрешений.
8. Иконка, скриншоты, страница приватности, подача в App Store.

## Что можно не переносить

- Service Worker и весь офлайн-слой.
- `safeStorage` с фолбэком в память — в iOS `UserDefaults` не отваливается.
- Сторож `finishStory` и обработчик `visibilitychange` — костыли против заморозки `rAF`.
- Ручной lerp курса: `withAnimation` делает это лучше.
