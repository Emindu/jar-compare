# Mermaid diagram gallery

One example of each common diagram type. Open **View** on any diagram to change its layout engine, direction, look or theme.

## Flowchart

```mermaid
flowchart TD
    Start([Request]) --> Auth{Authenticated?}
    Auth -->|no| Login[Show login]
    Auth -->|yes| Cache{In cache?}
    Cache -->|yes| Serve[Serve cached page]
    Cache -->|no| Render[Render page] --> Store[(Cache)] --> Serve
```

## Sequence

```mermaid
sequenceDiagram
    autonumber
    actor User
    participant API
    participant DB
    User->>API: GET /orders
    API->>DB: SELECT orders
    DB-->>API: rows
    API-->>User: 200 OK
```

## Class

```mermaid
classDiagram
    class Order {
        +String id
        +List~Line~ lines
        +total() Money
    }
    class Line {
        +String sku
        +int qty
    }
    Order "1" *-- "many" Line
```

## State

```mermaid
stateDiagram-v2
    [*] --> Draft
    Draft --> Submitted: submit
    Submitted --> Approved: approve
    Submitted --> Draft: reject
    Approved --> [*]
```

## Entity relationship

```mermaid
erDiagram
    CUSTOMER ||--o{ ORDER : places
    ORDER ||--|{ LINE_ITEM : contains
    PRODUCT ||--o{ LINE_ITEM : "ordered in"
```

## Gantt

```mermaid
gantt
    title Release plan
    dateFormat YYYY-MM-DD
    section Build
    Design      :a1, 2026-01-05, 7d
    Implement   :a2, after a1, 14d
    section Ship
    Test        :after a2, 5d
    Release     :milestone, 2026-02-02, 0d
```

## Pie

```mermaid
pie title Time spent
    "Coding" : 45
    "Reviews" : 20
    "Meetings" : 15
    "Docs" : 20
```

## Mindmap

```mermaid
mindmap
  root((Markdown editor))
    Writing
      Shortcuts
      Slash menu
    Preview
      Outline
      Diagrams
    Sharing
      Download
      Print
```
