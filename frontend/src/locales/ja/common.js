// Generated against the English schema. Keep every key translated.
const TRANSLATIONS = {
  "syncConflict": {
    "title": "同期の競合",
    "description": "{{count}} 件のローカル変更を確認してください。",
    "sameField": "別のデバイスでも同じフィールドが変更されました。",
    "historyExpired": "バージョン履歴が期限切れのため、完全確認が必要です。",
    "failedMutation": "ローカル変更に失敗しました: {{error}}",
    "useServer": "サーバーの値を使用",
    "keepLocal": "ローカル変更を保持",
    "discardLocal": "ローカル変更を破棄",
    "retry": "再試行",
    "serverApplied": "サーバーの値を復元しました。",
    "localApplied": "ローカル変更を再送信しました。",
    "missingVersion": "最新のサーバーバージョンを取得できません。",
    "failed": "同期の競合を解決できませんでした。",
    "collapse": "折りたたむ",
    "expand": "同期の競合を展開"
  },
  "onboarding": {
    "home": {
      "getStarted": "はじめる",
      "welcome": "ようこそ"
    },
    "llm": {
      "title": "LLMの設定",
      "description": "Athenaは多くのLLMプロバイダーと連携できます。これがチャットを処理するサービスになります。"
    },
    "userSetup": {
      "title": "ユーザー設定",
      "description": "ユーザー設定を構成します。",
      "howManyUsers": "このインスタンスを使用するユーザー数は？",
      "justMe": "自分だけ",
      "myTeam": "チーム",
      "instancePassword": "インスタンスパスワード",
      "setPassword": "パスワードを設定しますか？",
      "passwordReq": "パスワードは8文字以上である必要があります。",
      "passwordWarn": "このパスワードを保存することが重要です。回復方法はありません。",
      "adminUsername": "管理者アカウントのユーザー名",
      "adminPassword": "管理者アカウントのパスワード",
      "adminPasswordReq": "パスワードは8文字以上である必要があります。",
      "teamHint": "デフォルトでは、あなたが唯一の管理者になります。オンボーディングが完了した後、他のユーザーや管理者を作成して招待できます。パスワードを紛失しないでください。管理者のみがパスワードをリセットできます。"
    },
    "data": {
      "title": "データ処理とプライバシー",
      "description": "個人データに関して透明性とコントロールを提供することをお約束します。",
      "settingsHint": "これらの設定は、設定画面でいつでも再構成できます。"
    },
    "survey": {
      "title": "Athenaへようこそ",
      "description": "Athenaをあなたのニーズに合わせて構築するためにご協力ください。任意です。",
      "email": "メールアドレスは何ですか？",
      "useCase": "Athenaを何に使用しますか？",
      "useCaseWork": "仕事用",
      "useCasePersonal": "個人用",
      "useCaseOther": "その他",
      "comment": "Athenaをどのように知りましたか？",
      "commentPlaceholder": "Reddit、Twitter、GitHub、YouTubeなど - どのように見つけたか教えてください！",
      "skip": "アンケートをスキップ",
      "thankYou": "フィードバックありがとうございます！"
    }
  },
  "common": {
    "productName": "Athena",
    "defaultSiteTitle": "Athena | ナレッジ・オペレーティング・システム",
    "controls": {
      "settings": "設定",
      "settingsDescription": "システム設定を開き、表示、モデルプロバイダー、セキュリティ、ワークスペース管理を調整します。",
      "workspaceSettings": "ワークスペース設定",
      "workspaceSettingsDescription": "このワークスペースの設定を開き、表示、ドキュメント、メンバー、動作を調整します。",
      "backToWorkspace": "ワークスペースへ戻る",
      "showSidebar": "サイドバーを表示（{{shortcut}}）",
      "hideSidebar": "サイドバーを閉じる（{{shortcut}}）"
    },
    "clear": "クリア",
    "workspaces-name": "ワークスペース名",
    "overviewPage": "概要",
    "newThread": "新しいスレッド",
    "startingThread": "スレッドを開始中...",
    "selection": "モデル選択",
    "saving": "保存中...",
    "save": "変更を保存",
    "previous": "前のページ",
    "next": "次のページ",
    "optional": "任意",
    "yes": "はい",
    "no": "いいえ",
    "search": "検索",
    "developmentMode": "開発モード",
    "username_requirements": "ユーザー名は2〜32文字で、小文字で始まり、小文字、数字、アンダースコア、ハイフン、ピリオドのみを含む必要があります。",
    "on": "～について",
    "none": "なし",
    "stopped": "停止",
    "loading": "読み込み中",
    "refresh": "リフレッシュ",
    "thread": "スレッド",
    "default": "デフォルト",
    "running": "実行中",
    "completed": "完了",
    "failed": "失敗",
    "return-running-thread": "実行中のスレッドに戻る"
  },
  "settings": {
    "title": "インスタンス設定",
    "invites": "招待",
    "users": "ユーザー",
    "workspaces": "ワークスペース",
    "workspace-chats": "ワークスペースチャット",
    "customization": "カスタマイズ",
    "api-keys": "開発者API",
    "llm": "LLM",
    "transcription": "文字起こし",
    "embedder": "埋め込みエンジン",
    "search-model": "検索モデル",
    "vision": "視覚モデル",
    "text-splitting": "テキスト分割とチャンク化",
    "voice-speech": "音声とスピーチ",
    "vector-database": "ベクターデータベース",
    "embeds": "チャット埋め込み",
    "security": "セキュリティ",
    "button-lab": "ボタンラボ",
    "mobile-page-experiment": "モバイルページ実験",
    "character-performance-lab": "キャラクター演技マッピング",
    "athena-3d-center": "Athena 3D センター",
    "crypto-component-experiment": "暗号コンポーネント実験",
    "crypto-center": "Cryptoセンター",
    "event-logs": "イベントログ",
    "system-patrol": "システム巡回",
    "privacy": "プライバシーとデータ",
    "ai-providers": "AIプロバイダー",
    "agent-skills": "エージェントスキル",
    "admin": "管理者",
    "tools": "ツール",
    "system-prompt-variables": "システムプロンプト変数",
    "default-system-prompt": "デフォルトシステムプロンプト",
    "experimental-features": "実験的機能",
    "contact": "サポートに連絡",
    "browser-extension": "ブラウザ拡張",
    "interface": "UI設定",
    "branding": "ブランディングとホワイトレーベル化",
    "chat": "チャット",
    "mobile-app": "Athena モバイル版",
    "community-hub": {
      "title": "地域交流拠点",
      "trending": "人気のあるものを探す",
      "your-account": "あなたのアカウント",
      "import-item": "輸入品"
    },
    "channels": "チャンネル",
    "available-channels": {
      "telegram": "テレグラム",
      "wechat": "WeChat コネクタ",
      "advanced-gateway": "Advanced Gateway コネクタ"
    },
    "scheduled-jobs": "計画された作業",
    "reranker": "リランクモデル",
    "ocr": "OCRモデル",
    "batch-jobs": "バッチジョブ"
  },
  "login": {
    "multi-user": {
      "welcome": "ようこそ",
      "placeholder-username": "ユーザー名",
      "placeholder-password": "パスワード",
      "login": "ログイン",
      "validating": "検証中...",
      "forgot-pass": "パスワードを忘れた",
      "reset": "リセット"
    },
    "sign-in": "{{appName}} アカウントにサインインします。",
    "password-reset": {
      "title": "パスワードリセット",
      "description": "以下に必要な情報を入力してパスワードをリセットしてください。",
      "recovery-codes": "回復コード",
      "back-to-login": "ログイン画面に戻る",
      "email-title": "メールによるパスワードリセット",
      "email-description": "確認済みのアカウントメールを使用して、6桁のコードを受け取ります。",
      "verified-email": "確認済みメール",
      "verification-code": "認証コード",
      "send-code": "認証コードを送信",
      "resend-code-in": "{{seconds}}秒後に再送信",
      "sending": "送信中...",
      "use-email": "代わりにメール認証を使用",
      "use-recovery-codes": "代わりにリカバリコードを使用",
      "generic-email-sent": "アカウントと確認済みメールが存在する場合、認証コードが送信されました。"
    }
  },
  "new-workspace": {
    "title": "新しいワークスペース",
    "placeholder": "マイワークスペース"
  },
  "workspaces—settings": {
    "general": "一般設定",
    "chat": "チャット設定",
    "vector": "ベクターデータベース",
    "health": "ヘルスセンター",
    "reading": "読書ツール",
    "members": "メンバー",
    "agent": "エージェント構成"
  },
  "reading-tools": {
    "eyebrow": "読書ツール",
    "title": "文字サイズと読書プレビュー",
    "description": "これはグローバルな画面設定です。チャット、入力欄、読書プレビューに即時反映され、バックグラウンドでは最後に止まった設定だけをアカウントへ同期します。",
    "sizeTitle": "文字サイズ",
    "previewTitle": "ライブプレビュー",
    "currentSelection": "現在の選択：{{label}}",
    "customSliderLabel": "カスタム文字サイズ",
    "customRange": "{{min}}px から {{max}}px",
    "decrease": "文字サイズを小さくする",
    "increase": "文字サイズを大きくする",
    "customStep": "{{size}}px に設定",
    "userPreview": "ユーザーメッセージのプレビュー：この資料をわかりやすい知識構造に整理してください。",
    "options": {
      "compact": {
        "label": "コンパクト",
        "description": "長い会話を密に確認するための最小サイズです。"
      },
      "small": {
        "label": "小",
        "description": "すばやく確認しやすいやや小さめの表示です。"
      },
      "normal": {
        "label": "標準",
        "description": "Athena の標準的な読書サイズです。"
      },
      "comfortable": {
        "label": "快適",
        "description": "標準より少しゆったりした長時間読書向けです。"
      },
      "large": {
        "label": "大",
        "description": "長時間の読書やデモに適した、より快適なサイズです。"
      },
      "xlarge": {
        "label": "特大",
        "description": "発表、投影、視認性を優先する場面向けです。"
      },
      "custom": {
        "label": "カスタム",
        "labelWithSize": "カスタム {{size}}px",
        "description": "スライダーを 1px 単位で調整します。バックグラウンド同期では最後の値だけを保存します。"
      }
    },
    "previewMarkdown": "### アシスタント回答プレビュー\n\nこれは文字サイズ、行間、強調表示の読みやすさを確認するための **Markdown の太字テキスト** です。\n\n- リスト項目は読みやすい間隔を保ちます\n- 日本語と English text を一緒に表示できます\n\n> 引用ブロックは出典の抜粋や推論メモを表示します。\n\n```js\nconst readable = true;\n```\n"
  },
  "workspace-health": {
    "unavailable": "なし",
    "unknown": "不明",
    "unknownEyebrow": "状態を利用できません",
    "processing": "処理中",
    "processingEyebrow": "バックグラウンドタスクが実行中です",
    "healthy": "正常",
    "healthyEyebrow": "ワークスペースは正常に動作しています",
    "attention": "要確認",
    "attentionEyebrow": "軽微なリスクがあります",
    "degraded": "低下",
    "degradedEyebrow": "調査が必要です",
    "critical": "重大",
    "criticalEyebrow": "直ちに対応が必要です",
    "warning": "警告",
    "info": "情報",
    "scoreUnit": "点",
    "ariaOpen": "ワークスペースのヘルス状態：{{score}}、{{status}}。Enter キーでヘルスセンターを開きます",
    "title": "ワークスペースヘルスセンター",
    "eyebrow": "ワークスペースの可観測性",
    "description": "ナレッジグラフ、修復タスク、ノード指標、バックグラウンド Worker、キュー、モデルサービス、キャッシュの軽量な可観測状態を表示します。更新はヘルス集計キャッシュのみを更新し、埋め込み、ベクトル再構築、グラフ抽出、修復タスクは実行しません。",
    "refresh": "ヘルス状態を更新",
    "refreshAfter": "{{seconds}}秒後に更新可能",
    "healthScore": "ワークスペースヘルススコア",
    "lastUpdated": "最終更新：{{time}}",
    "summaryCache": "要約キャッシュ：{{time}}",
    "latestActivity": "最新アクティビティ：{{time}}",
    "workerHeartbeat": "Worker ハートビート：{{time}}",
    "summaryFallback": "ヘルス状態は一時的に利用できません",
    "currentIssues": "現在の問題",
    "scoreSources": "スコア減点の要因",
    "noScoreSources": "現在有効な減点項目はありません。この問題は最新のヘルス集計で回復している可能性があります。",
    "pointsLost": "-{{points}} 点",
    "severity": "重大度：{{severity}}",
    "cacheNote": "キャッシュ情報：期限切れの traversal キャッシュが {{count}} 件あります。キャッシュは必要に応じて再構築され、ヘルススコアには影響しません。",
    "noIssues": "直ちに対応が必要な問題はありません。",
    "processingTitle": "処理中",
    "noProcessing": "現在処理中のヘルスタスクはありません。",
    "timeline": "最近のアクティビティタイムライン",
    "recentActivity": "最近のアクティビティ",
    "abnormalEvents": "異常イベント",
    "noRecentActivity": "最近のアクティビティはありません。",
    "advancedInfo": "詳細情報",
    "advancedDiagnostics": "高度な診断データ",
    "dataSourceTimes": "データソース時刻",
    "adjustReadingTools": "読書ツールと文字サイズを調整",
    "fullDiagnostics": "完全な診断を表示",
    "activityTitles": {
      "nodeMetrics": "ノード指標",
      "kgExtraction": "ナレッジグラフ抽出",
      "graphRepair": "グラフ修復",
      "recomputeNodeMetrics": "ノード指標を再計算"
    },
    "activityDetails": {
      "processed": "処理",
      "succeeded": "成功",
      "failed": "失敗",
      "skipped": "スキップ"
    }
  },
  "workspace-overview": {
    "workspaceOverview": "ワークスペース概要",
    "overviewGenerating": "概要を生成中",
    "workspaceHealth": "ワークスペースヘルス",
    "unknown": "不明",
    "healthUnavailable": "ヘルス状態は利用できません",
    "healthNote": "おすすめ、証拠、関係、処理状態を組み合わせた総合的な読み取り",
    "continueLast": "前回の研究を続ける",
    "noContinue": "再開できる研究パスはありません。",
    "recommended": "おすすめ",
    "noRecommendations": "まだおすすめはありません。概念や証拠を確認し続けると、ここがより賢くなります。",
    "knowledgeGaps": "知識ギャップ"
  },
  "workspaceSupplement": {
    "tool": {
      "title": "ツールプレビュー",
      "description": "これらの補足はコンテキストへ一括投入せず、必要に応じてモデル用ツールとして公開されます。",
      "availableKinds": "利用可能な補足タイプ",
      "customDocuments": "カスタム補足ドキュメント",
      "noAvailableSupplements": "利用可能な補足はありません"
    },
    "kinds": {
      "structure_json": "構造説明",
      "reading_guide": "読書ガイド",
      "chapter_overview": "章の概要",
      "timeline": "タイムライン",
      "person_map": "人物関係",
      "concept_index": "概念索引",
      "summary_standard": "要約基準"
    },
    "kindDescriptions": {
      "structure_json": "構造、主軸、副軸、ノード解析基準に使用します。",
      "reading_guide": "読む順序、主題範囲、学習方法に使用します。",
      "chapter_overview": "章の役割、章同士の関係、学習重点に使用します。",
      "timeline": "時系列、展開、因果関係に使用します。",
      "person_map": "人物の見解、影響関係、比較に使用します。",
      "concept_index": "定義、関連概念、誤解しやすい点に使用します。",
      "summary_standard": "要約構成、必須観点、誤読禁止事項に使用します。"
    },
    "customDocumentDescription": "具体的なタイトルで公開されるカスタム補足ドキュメントです。",
    "structureJsonValid": "構造は有効",
    "structureJsonInvalid": "構造は確認が必要",
    "usagePreview": "プレビュー"
  },
  "system-prompt-variables": {
    "title": "システムプロンプト変数",
    "description": "システムプロンプト変数は設定値を保存するために使用され、システムプロンプト内で参照して動的な内容をプロンプトに含められます。",
    "addVariable": "変数を追加",
    "noVariables": "変数が見つかりません",
    "edit": "編集",
    "columns": {
      "key": "キー",
      "value": "値",
      "description": "説明",
      "type": "種類"
    },
    "types": {
      "system": "システム",
      "user": "ユーザー",
      "workspace": "ワークスペース",
      "static": "静的"
    },
    "variableDescriptions": {
      "time": "現在時刻",
      "date": "現在の日付",
      "datetime": "現在の日付と時刻",
      "user.id": "現在のユーザー ID",
      "user.name": "現在のユーザー名",
      "user.bio": "現在のユーザープロフィールの自己紹介項目",
      "workspace.id": "現在のワークスペース ID",
      "workspace.name": "現在のワークスペース名"
    },
    "form": {
      "addTitle": "新しい変数を追加",
      "editTitle": "{{key}} を編集",
      "keyPlaceholder": "例: company_name",
      "valuePlaceholder": "例: Acme Corp",
      "descriptionPlaceholder": "任意の説明",
      "keyHint": "キーは一意である必要があり、プロンプト内では {key} として使用されます。使用できるのは英字、数字、アンダースコアのみです。",
      "cancel": "キャンセル",
      "create": "変数を作成",
      "update": "変数を更新"
    },
    "deleteConfirm": {
      "title": "変数を削除しますか？",
      "description": "変数「{{key}}」を削除します。この操作は元に戻せません。",
      "confirm": "削除"
    },
    "toasts": {
      "created": "変数を作成しました",
      "updated": "変数を更新しました",
      "deleted": "変数を削除しました"
    },
    "errors": {
      "prefix": "エラー",
      "required": "キーと値は必須です",
      "create": "変数の作成に失敗しました",
      "update": "変数の更新に失敗しました",
      "delete": "変数の削除に失敗しました"
    }
  },
  "experimental-features": {
    "title": "実験的機能",
    "selectFeature": "実験的機能を選択",
    "status": {
      "on": "オン",
      "off": "オフ"
    },
    "toasts": {
      "enabledSet": "実験的機能セットを有効にしました。ページを再読み込みします。"
    },
    "tos": {
      "title": "実験的機能の利用条件",
      "introStart": "Athena の実験的機能は試験運用中の機能であり、利用には",
      "introSeparator": " ",
      "optIn": "明示的な有効化",
      "optInSuffix": "が必要です。",
      "introEnd": "機能の承認前に潜在的な懸念がある場合は、条件や警告を事前に提示します。",
      "risksIntro": "このページの機能を使用すると、以下を含む可能性があります。",
      "risks": {
        "dataLoss": "データの損失。",
        "qualityChange": "結果品質の変化。",
        "storageIncrease": "ストレージ使用量の増加。",
        "resourceIncrease": "リソース消費量の増加。",
        "cost": "接続済みの LLM または埋め込みプロバイダーの費用や使用量の増加。",
        "bugs": "Athena 使用時のバグや問題の発生。"
      },
      "conditionsIntro": "実験的機能の使用には、以下の非網羅的な条件も伴います。",
      "conditions": {
        "futureRemoval": "今後の更新でこの機能が存在しなくなる場合があります。",
        "unstable": "使用中の機能は現在安定版ではありません。",
        "availability": "今後のバージョン、構成、または Athena のサブスクリプションで利用できない場合があります。",
        "privacyStart": "ベータ機能の使用時も、プライバシー設定は",
        "privacySeparator": " ",
        "privacyBold": "尊重されます",
        "privacyEnd": "。",
        "mayChange": "これらの条件は今後の更新で変更される場合があります。"
      },
      "moreInfoPrefix": "機能にアクセスするには、このモーダルでの承認が必要です。詳しく読むには",
      "moreInfoOrEmail": "を参照するか、メールでお問い合わせください:",
      "reject": "拒否して閉じる",
      "accept": "理解しました"
    },
    "liveSync": {
      "navTitle": "ライブドキュメント同期",
      "title": "ドキュメント内容の自動同期",
      "description": "ドキュメントを「監視」対象として指定できるようにします。監視中のドキュメント内容は定期的に取得され、Athena に更新されます。",
      "workspaceUpdate": "監視中のドキュメントは、参照されているすべてのワークスペースで同時に自動更新されます。",
      "webOnly": "この機能は、Web サイト、Confluence、YouTube、GitHub ファイルなどの Web ベースのコンテンツにのみ適用されます。",
      "docsLink": "機能ドキュメントと警告",
      "manageLink": "監視中のドキュメントを管理",
      "toasts": {
        "enabled": "ライブドキュメント内容同期を有効にしました。",
        "disabled": "ライブドキュメント内容同期を無効にしました。"
      },
      "errors": {
        "update": "機能ステータスの更新に失敗しました。"
      },
      "manage": {
        "title": "監視中のドキュメント",
        "description": "現在このインスタンスで監視されているすべてのドキュメントです。これらのドキュメントの内容は定期的に同期されます。",
        "columns": {
          "documentName": "ドキュメント名",
          "lastSynced": "最終同期",
          "nextRefresh": "次回更新までの時間",
          "createdOn": "作成日"
        }
      }
    }
  },
  "audio-preference": {
    "stt": {
      "title": "音声入力設定",
      "description": "ここでは、Athena で使用するテキスト読み上げおよび音声入力プロバイダーを指定できます。既定ではブラウザ内蔵の対応機能を使用しますが、他のプロバイダーも利用できます。",
      "searchPlaceholder": "音声入力プロバイダーを検索"
    },
    "tts": {
      "title": "テキスト読み上げ設定",
      "description": "ここでは、Athena で使用するテキスト読み上げプロバイダーを指定できます。既定ではブラウザ内蔵の対応機能を使用しますが、他のプロバイダーも利用できます。",
      "searchPlaceholder": "テキスト読み上げプロバイダーを検索"
    },
    "provider": "プロバイダー",
    "noConfiguration": "このプロバイダーに必要な設定はありません。",
    "loadingModels": "-- 利用可能なモデルを読み込み中 --",
    "providers": {
      "native": {
        "name": "システム標準",
        "sttDescription": "対応している場合、ブラウザ内蔵の STT サービスを使用します。",
        "ttsDescription": "対応している場合、ブラウザ内蔵の TTS サービスを使用します。"
      },
      "openai": {
        "description": "OpenAI のテキスト読み上げ音声を使用します。"
      },
      "elevenlabs": {
        "description": "ElevenLabs のテキスト読み上げ音声と技術を使用します。"
      },
      "piper": {
        "description": "TTS モデルをブラウザ内でローカルかつ非公開に実行します。"
      },
      "openaiCompatible": {
        "name": "OpenAI 互換",
        "description": "ローカルまたはリモートで動作する OpenAI 互換 TTS サービスに接続します。"
      }
    },
    "fields": {
      "apiKey": "API キー",
      "baseUrl": "ベース URL",
      "ttsModel": "TTS モデル",
      "voiceModel": "音声モデル",
      "voiceModelSelection": "音声モデル選択"
    },
    "toasts": {
      "sttSaved": "音声入力設定を保存しました。",
      "sttSaveFailed": "設定の保存に失敗しました: {{error}}",
      "ttsSaved": "テキスト読み上げ設定を保存しました。",
      "ttsSaveFailed": "設定の保存に失敗しました: {{error}}"
    },
    "piper": {
      "description": "すべての PiperTTS モデルはブラウザ内でローカル実行されます。低スペックの端末ではリソースを多く消費する場合があります。",
      "storedModelHint": "「✔」は、このモデルがすでにローカルに保存されており、実行時にダウンロード不要であることを示します。",
      "flushCache": "音声キャッシュをクリア",
      "stopDemo": "デモを停止",
      "loadingVoice": "音声を読み込み中",
      "playSample": "サンプルを再生",
      "toasts": {
        "flushed": "ブラウザストレージからすべての音声をクリアしました"
      }
    },
    "openaiCompatible": {
      "baseUrlHint": "TTS 応答の生成に使用する OpenAI 互換 TTS サービスのベース URL を指定します。",
      "apiKeyHint": "一部の TTS サービスでは応答生成に API キーが必要です。サービスがキーを要求しない場合、この項目は任意です。",
      "ttsPlaceholder": "TTS モデル識別子",
      "voicePlaceholder": "音声モデル識別子",
      "ttsModelHintStart": "多くの TTS サービスには複数のモデルがあります。これは使用するモデルを選択するための",
      "ttsModelHintEnd": "パラメーターです。注: これは音声モデルとは異なります。",
      "voiceModelHint": "多くの TTS サービスには複数の音声モデルがあります。ここには使用したい音声モデルの識別子を指定します。"
    }
  },
  "default-system-prompt": {
    "title": "デフォルトシステムプロンプト",
    "description": "これは新しいワークスペースで使用されるデフォルトのシステムプロンプトです。",
    "form": {
      "label": "システムプロンプト",
      "helpStart": "システムプロンプトは、AI の応答と動作を形作る指示を提供します。このプロンプトは、新しく作成されるすべてのワークスペースに自動的に適用されます。",
      "helpStartSeparator": " ",
      "specificWorkspace": "特定のワークスペース",
      "helpMiddle": "のシステムプロンプトを変更するには、",
      "helpMiddleSeparator": " ",
      "workspaceSettings": "ワークスペース設定",
      "helpEnd": "でプロンプトを編集します。システムプロンプトを標準のデフォルトに戻すには、このフィールドを空にして変更を保存してください。",
      "variablesPrefix": "挿入できるもの:",
      "variablesLink": "システムプロンプト変数",
      "variablesLike": "例:",
      "moreVariables": "+{{count}} 件以上...",
      "placeholder": "あなたは質問に答え、タスクを手伝うことができる AI アシスタントです。",
      "syncExisting": "既存のデフォルトワークスペースに同期",
      "syncExistingHint": "古いデフォルトプロンプトをまだ使用しているワークスペースのみを更新します。カスタムワークスペースプロンプトは上書きされません。"
    },
    "toasts": {
      "updated": "デフォルトシステムプロンプトを更新しました。",
      "updateFailed": "デフォルトシステムプロンプトの更新に失敗しました: {{error}}",
      "updatedWithSync": "デフォルトのシステムプロンプトが正常に更新されました。{{synced}} 個のワークスペースを同期し、{{skipped}} 個のカスタムワークスペースをスキップし、{{failed}} 個が失敗しました。"
    }
  },
  "general": {
    "vector": {
      "title": "ベクター数",
      "description": "ベクターデータベース内のベクターの総数。"
    },
    "names": {
      "description": "これはワークスペースの表示名のみを変更します。"
    },
    "message": {
      "title": "提案されたチャットメッセージ",
      "description": "ワークスペースユーザーに提案されるメッセージをカスタマイズします。",
      "add": "新しいメッセージを追加",
      "save": "メッセージを保存",
      "heading": "説明してください",
      "body": "Athenaの利点"
    },
    "delete": {
      "title": "ワークスペースを削除",
      "description": "このワークスペースとそのすべてのデータを削除します。これにより、すべてのユーザーのワークスペースが削除されます。",
      "delete": "ワークスペースを削除",
      "deleting": "ワークスペースを削除中...",
      "confirm-start": "ワークスペース全体を削除しようとしています",
      "confirm-end": "ワークスペース。この操作により、ベクターデータベース内のすべてのベクター埋め込みが削除されます。\n\n元のソースファイルはそのまま残ります。この操作は元に戻せません。"
    }
  },
  "chat": {
    "llm": {
      "title": "ワークスペースLLMプロバイダー",
      "description": "このワークスペースで使用するLLMプロバイダーとモデルを指定します。デフォルトではシステムのLLMプロバイダーと設定が使用されます。",
      "search": "すべてのLLMプロバイダーを検索"
    },
    "model": {
      "title": "ワークスペースチャットモデル",
      "description": "このワークスペースで使用するチャットモデルを指定します。空の場合はシステムのLLM設定が使用されます。"
    },
    "mode": {
      "title": "チャットモード",
      "chat": {
        "title": "チャット",
        "description": "LLMの一般的な知識<b>と</b>見つかったドキュメントのコンテキストを使用して回答します。<br />ツールを使用するには@agentコマンドを使用する必要があります。"
      },
      "query": {
        "title": "クエリ",
        "description": "ドキュメントのコンテキストが見つかった場合<b>のみ</b>回答します。<br />ツールを使用するには@agentコマンドを使用する必要があります。"
      },
      "automatic": {
        "description": "モデルとプロバイダーがネイティブツール呼び出しをサポートしている場合、自動的にツールを使用します。<br />ネイティブツールがサポートされていない場合は、ツールを使用するには@agentコマンドを使用する必要があります。",
        "title": "代理人"
      }
    },
    "history": {
      "title": "チャット履歴",
      "desc-start": "応答の短期記憶に含まれる過去のチャット数。",
      "recommend": "推奨値: 20",
      "desc-end": "45以上にすると、メッセージサイズによっては継続的なチャット失敗が発生する可能性があります。"
    },
    "prompt": {
      "title": "プロンプト",
      "description": "このワークスペースで使用するプロンプトです。AIが適切な応答を生成できるよう、コンテキストや指示を定義してください。",
      "history": {
        "title": "システムプロンプトの履歴",
        "clearAll": "クリアすべて",
        "noHistory": "利用履歴は保存されていません。",
        "restore": "復元",
        "delete": "削除",
        "deleteConfirm": "本当にこの履歴項目を削除してもよろしいですか？",
        "clearAllConfirm": "本当に履歴をすべて削除したくないですか？ この操作は取り消すことができません。",
        "expand": "拡大",
        "publish": "コミュニティハブに公開する"
      }
    },
    "refusal": {
      "title": "クエリモード拒否応答",
      "desc-start": "モードが",
      "query": "クエリ",
      "desc-end": "の場合、コンテキストが見つからないときにカスタム拒否応答を返すことができます。",
      "tooltip-title": "なぜ、私はこれを見ているのだろう？",
      "tooltip-description": "現在、クエリモードで、お客様のドキュメントからのみ情報を取得しています。より柔軟な会話をご希望の場合は、チャットモードに切り替えてください。チャットモードについて詳しく知りたい場合は、こちらをクリックして、当社のドキュメントをご覧ください。"
    },
    "temperature": {
      "title": "LLM温度",
      "desc-start": "この設定はLLMの応答の創造性を制御します。",
      "desc-end": "数値が高いほど創造的になりますが、高すぎると一部のモデルでは一貫性のない応答になる場合があります。",
      "hint": "多くのLLMには有効な値の範囲があります。詳細はLLMプロバイダーの情報を参照してください。"
    }
  },
  "vector-workspace": {
    "identifier": "ベクターデータベース識別子",
    "snippets": {
      "title": "最大コンテキストスニペット数",
      "description": "この設定は、チャットやクエリごとにLLMへ送信される最大コンテキストスニペット数を制御します。",
      "recommend": "推奨値: 4"
    },
    "doc": {
      "title": "ドキュメント類似度しきい値",
      "description": "チャットに関連すると見なされるために必要な最小類似度スコアです。数値が高いほど、より類似したソースのみが対象となります。",
      "zero": "制限なし",
      "low": "低（類似度スコア ≥ 0.25）",
      "medium": "中（類似度スコア ≥ 0.50）",
      "high": "高（類似度スコア ≥ 0.75）"
    },
    "reset": {
      "reset": "ベクターデータベースをリセット",
      "resetting": "ベクターをクリア中...",
      "confirm": "このワークスペースのベクターデータベースをリセットしようとしています。これにより、現在埋め込まれているすべてのベクターが削除されます。\n\n元のソースファイルはそのまま残ります。この操作は元に戻せません。",
      "error": "ワークスペースのベクターデータベースをリセットできませんでした！",
      "success": "ワークスペースのベクターデータベースがリセットされました！"
    }
  },
  "agent": {
    "performance-warning": "ツール呼び出しに対応していないLLMの性能は、モデルの能力や精度に大きく依存します。一部の機能が制限されたり、正しく動作しない場合があります。",
    "provider": {
      "title": "ワークスペースエージェントのLLMプロバイダー",
      "description": "このワークスペースの@agentで使用するLLMプロバイダーとモデルを指定します。"
    },
    "mode": {
      "chat": {
        "title": "ワークスペースエージェントのチャットモデル",
        "description": "このワークスペースの@agentで使用するチャットモデルを指定します。"
      },
      "title": "ワークスペースエージェントのモデル",
      "description": "このワークスペースの@agentで使用するLLMモデルを指定します。",
      "wait": "-- モデルを読み込み中 --"
    },
    "skill": {
      "cryptoMarket": {
        "title": "暗号資産マーケット",
        "description": "Gate と Binance の公開スポット価格と市場スナップショットを読み取り専用で取得します。個人口座へのアクセスや取引操作は行いません。"
      },
      "weather": {
        "title": "天気情報",
        "description": "QWeather を使用し、中国の都市名または GPS 座標から現在の天気と 3、7、10、15、30 日予報を取得します。"
      },
      "globalMarket": {
        "title": "グローバル市場",
        "description": "Juhe、Stooq、Frankfurter から為替、指数、株式、商品、ファンド、ETF の相場を読み取り専用で取得します。"
      },
      "marketData": {
        "credentials": "プロバイダー認証情報",
        "configured": "設定済み",
        "notConfigured": "設定が必要",
        "qweatherKey": "QWeather API キー",
        "juheStockKey": "Juhe 株式 API キー",
        "juheForexKey": "Juhe 為替 API キー",
        "secretHelp": "認証情報は Athena の現在のデータキーで暗号化して保存されます。既存の値は再表示されず、置き換える場合のみ新しい値を入力します。"
      },
      "rag": {
        "title": "RAGと長期記憶",
        "description": "エージェントがローカルドキュメントを活用して質問に答えたり、内容を「記憶」して長期的に参照できるようにします。"
      },
      "view": {
        "title": "ドキュメントの閲覧と要約",
        "description": "エージェントがワークスペース内のファイルを一覧表示し、内容を要約できるようにします。"
      },
      "scrape": {
        "title": "ウェブサイトの取得",
        "description": "エージェントがウェブサイトを訪問し、内容を取得できるようにします。"
      },
      "surveys": {
        "title": "Agent Surveys / 確認質問",
        "description": "エージェントが処理を続ける前に最大3件の確認質問を行い、推奨選択肢と自由入力欄を提示できるようにします。"
      },
      "generate": {
        "title": "チャートの生成",
        "description": "デフォルトエージェントがチャットやデータからさまざまなチャートを作成できるようにします。"
      },
      "web": {
        "title": "ウェブ検索と閲覧",
        "description": "エージェントがウェブ検索（SERP）プロバイダーに接続することで、あなたの質問に答えるためにウェブを検索できるようにする。"
      },
      "sql": {
        "title": "SQLコネクタ",
        "description": "エージェントが、さまざまなSQLデータベースプロバイダーに接続することで、SQLを活用してお客様からの質問に回答できるようにする。"
      },
      "default_skill": "デフォルトでは、この機能は有効になっていますが、エージェントに利用させたくない場合は、無効にすることができます。",
      "filesystem": {
        "title": "ファイルシステムのアクセス",
        "description": "エージェントが、指定されたディレクトリ内のファイルを読む、書き、検索、および管理できるようにします。ファイル編集、ディレクトリのナビゲーション、およびコンテンツ検索をサポートします。",
        "learnMore": "このスキルの使い方について、さらに詳しく知る",
        "configuration": "設定",
        "readActions": "行動",
        "writeActions": "行動",
        "warning": "ファイルシステムへのアクセスは危険であり、ファイルの内容を変更または削除する可能性があります。設定する前に、必ず<a>のドキュメント</a>を参照してください。",
        "skills": {
          "read-text-file": {
            "title": "ファイルを開く",
            "description": "ファイル（テキスト、コード、PDF、画像など）の内容を読み込む。"
          },
          "read-multiple-files": {
            "title": "複数のファイルを読み込む",
            "description": "複数のファイルを同時に読み込む"
          },
          "list-directory": {
            "title": "ディレクトリ一覧",
            "description": "フォルダ内のファイルとディレクトリの一覧を表示する"
          },
          "search-files": {
            "title": "ファイル検索",
            "description": "ファイル名または内容で検索する"
          },
          "get-file-info": {
            "title": "ファイルの情報を取得する",
            "description": "ファイルに関する詳細なメタデータを取得する"
          },
          "edit-file": {
            "title": "ファイル編集",
            "description": "テキストファイルの行単位での編集を行う"
          },
          "create-directory": {
            "title": "ディレクトリを作成する",
            "description": "新しいディレクトリを作成する"
          },
          "move-file": {
            "title": "ファイル/ファイル名の変更",
            "description": "ファイルやディレクトリを移動または名前を変更する"
          },
          "copy-file": {
            "title": "ファイルのコピー",
            "description": "ファイルとディレクトリをコピーする"
          },
          "write-text-file": {
            "title": "テキストファイルを作成する",
            "description": "新しいテキストファイルを作成するか、既存のテキストファイルを上書きする。"
          }
        }
      },
      "createFiles": {
        "title": "ドキュメント作成",
        "description": "エージェントが、パワーポイント、Excel、Word、PDFなどのバイナリ形式のドキュメントを作成できるようにします。ファイルはチャットウィンドウから直接ダウンロードできます。",
        "configuration": "利用可能なドキュメントの種類",
        "skills": {
          "create-text-file": {
            "title": "テキストファイル",
            "description": ".txt、.md、.json、.csvなどの拡張子を持つ、任意のコンテンツのテキストファイルを作成する。"
          },
          "create-pptx": {
            "title": "パワーポイント形式のプレゼンテーション",
            "description": "スライド、タイトル、箇条書きを含む、新しいPowerPointプレゼンテーションを作成する。"
          },
          "create-pdf": {
            "title": "PDFドキュメント",
            "description": "マークダウンまたはプレーンテキストから、基本的な書式設定を使用してPDFドキュメントを作成する。"
          },
          "create-xlsx": {
            "title": "エクセル スプレッドシート",
            "description": "表形式のデータをスプレッドシート形式で作成し、シートとスタイルを設定する。"
          },
          "create-docx": {
            "title": "Wordドキュメント",
            "description": "基本的なスタイルと書式でWordドキュメントを作成する"
          }
        }
      },
      "documentFormatting": {
        "title": "DOCX レイアウト最適化",
        "description": "現在のワークスペースにある Word 文書から、レイアウトを整えた新しい DOCX コピーを作成します。安全な場合は画像、表、ヘッダー、フッターを保持し、対応できない文書は警告付きで再構築します。元ファイルは上書きせず、書き込みのたびに確認します。"
      },
      "gmail": {
        "title": "Gmail 接続",
        "description": "エージェントがGmailと連携できるようにする：メールの検索、スレッドの閲覧、ドラフトの作成、メールの送信、およびインボックスの管理を可能にします。詳細については、<a>ドキュメントを参照</a>。",
        "multiUserWarning": "セキュリティ上の理由から、Gmailとの連携はマルチユーザーモードでは利用できません。この機能を使用するには、まずマルチユーザーモードを無効にしてください。",
        "configuration": "Gmail の設定",
        "deploymentId": "デプロイメントID",
        "deploymentIdHelp": "あなたのGoogle Apps ScriptウェブアプリケーションのデプロイメントID",
        "apiKey": "APIキー",
        "apiKeyHelp": "Google Apps Script のデプロイ時に設定した API キー",
        "configurationRequired": "Gmail の機能を有効にするには、デプロイメント ID と API キーを設定してください。",
        "configured": "設定済み",
        "searchSkills": "検索スキル...",
        "noSkillsFound": "検索条件に合致するスキルは見つかりませんでした。",
        "categories": {
          "search": {
            "title": "メールの検索と閲覧",
            "description": "Gmail の受信トレイから、メールを検索および閲覧する"
          },
          "drafts": {
            "title": "サンプルメール",
            "description": "メールの作成、編集、および管理"
          },
          "send": {
            "title": "メールの送信と返信",
            "description": "メールを送信し、スレッドへの返信をすぐに行う。"
          },
          "threads": {
            "title": "メールのトピックを管理する",
            "description": "メールのトピックを管理する - 既読/未読のマーク、アーカイブ、削除"
          },
          "account": {
            "title": "統合に関する統計",
            "description": "メールボックスの統計情報とアカウント情報を表示する"
          }
        },
        "skills": {
          "search": {
            "title": "メールを検索する",
            "description": "Gmail のクエリ構文を使用して、メールを検索する"
          },
          "readThread": {
            "title": "スレッドを読む",
            "description": "IDでメールの全文を閲覧する"
          },
          "createDraft": {
            "title": "ドラフト作成",
            "description": "新しいメールの草案を作成する"
          },
          "createDraftReply": {
            "title": "草案の返信を作成する",
            "description": "既存のスレッドに対する返信の草案を作成する"
          },
          "updateDraft": {
            "title": "ドラフトの更新",
            "description": "既存のメールドラフトを更新する"
          },
          "getDraft": {
            "title": "草案を入手",
            "description": "IDで特定のドラフトを取得する"
          },
          "listDrafts": {
            "title": "ドラフト案リスト",
            "description": "すべての草案メールの一覧を表示する"
          },
          "deleteDraft": {
            "title": "草案を削除",
            "description": "草案のメールを削除する"
          },
          "sendDraft": {
            "title": "草案を送信",
            "description": "既存のメールドラフトを送信する"
          },
          "sendEmail": {
            "title": "メールを送信する",
            "description": "すぐにメールを送信してください"
          },
          "replyToThread": {
            "title": "スレッドへの返信",
            "description": "メールのやり取りにすぐに返信する"
          },
          "markRead": {
            "title": "マーク・リード",
            "description": "スレッドを「読了」としてマークする"
          },
          "markUnread": {
            "title": "未読としてマーク",
            "description": "スレッドを「未読」としてマークする"
          },
          "moveToTrash": {
            "title": "ゴミ箱へ移動",
            "description": "スレッドをゴミ箱に移動する"
          },
          "moveToArchive": {
            "title": "アーカイブ",
            "description": "スレッドをアーカイブする"
          },
          "moveToInbox": {
            "title": "受信トレイへ移動",
            "description": "スレッドをインボックスに移動する"
          },
          "getMailboxStats": {
            "title": "メールボックスの統計情報",
            "description": "未読件数とメールボックスの統計情報を取得する"
          },
          "getInbox": {
            "title": "インボックスを開く",
            "description": "Gmail から受信したメールを効率的に取得する方法"
          }
        }
      },
      "outlook": {
        "title": "Outlook 連携機能",
        "description": "エージェントがMicrosoft Outlookとやり取りできるようにします - メールの検索、スレッドの読み取り、下書きの作成、メールの送信、Microsoft Graph APIを介した受信トレイの管理。 <a>ドキュメントを読む</a>",
        "multiUserWarning": "Outlookとの連携は、セキュリティ上の理由から、複数ユーザーモードでは利用できません。この機能を使い始めるには、複数ユーザーモードを無効にする必要があります。",
        "configuration": "Outlook の設定",
        "authType": "アカウントの種類",
        "authTypeHelp": "認証に使用できるMicrosoftアカウントの種類を選択します。「すべて」は、個人用アカウントと職場/学校用アカウントの両方をサポートします。「個人用のみ」は、個人用Microsoftアカウントに限定されます。「職場/学校用のみ」は、特定のAzure ADテナントからの職場/学校用アカウントに限定されます。",
        "authTypeCommon": "すべての口座（個人用および仕事/学校用）",
        "authTypeConsumers": "個人のMicrosoftアカウントのみ",
        "authTypeOrganization": "組織アカウントのみ（テナントIDが必要です）",
        "clientId": "アプリケーション（クライアント）ID",
        "clientIdHelp": "あなたのAzure ADアプリケーションの「アプリケーション（クライアント）ID」",
        "tenantId": "テナントID",
        "tenantIdHelp": "あなたの Azure AD アプリの登録から取得した「ディレクトリ（テナント）ID」。組織での認証のみに必要です。",
        "clientSecret": "クライアントの秘密",
        "clientSecretHelp": "Azure AD アプリの登録から取得したクライアントのシークレット値",
        "configurationRequired": "Outlook の機能を有効にするには、クライアント ID とクライアントシークレットを設定してください。",
        "authRequired": "まず、認証情報を保存し、その後、Microsoftとの認証を行い、設定を完了してください。",
        "authenticateWithMicrosoft": "マイクロソフトとの認証",
        "authenticated": "Microsoft Outlookとの認証に成功しました。",
        "revokeAccess": "アクセス権を停止する",
        "configured": "設定済み",
        "searchSkills": "検索スキル...",
        "noSkillsFound": "検索条件に一致するスキルは見つかりませんでした。",
        "categories": {
          "search": {
            "title": "メールの検索と閲覧",
            "description": "Outlook の受信トレイから、メールを検索して読み取る。"
          },
          "drafts": {
            "title": "サンプルメール",
            "description": "メールの作成、編集、および管理"
          },
          "send": {
            "title": "メールの送信",
            "description": "新しいメールを送信するか、すぐにメッセージに返信してください。"
          },
          "account": {
            "title": "統合に関する統計",
            "description": "メールボックスの統計情報とアカウント情報を確認する"
          }
        },
        "skills": {
          "getInbox": {
            "title": "受信トレイを開く",
            "description": "Outlook の受信トレイから、最近のメールを取得する"
          },
          "search": {
            "title": "メールを検索する",
            "description": "Microsoft の検索構文を使用してメールを検索する"
          },
          "readThread": {
            "title": "会話の内容を読み取る",
            "description": "メールのやり取り全体を読み込む"
          },
          "createDraft": {
            "title": "ドラフト作成",
            "description": "新しいメールの草案を作成するか、既存のメッセージへの返信の草案を作成する。"
          },
          "updateDraft": {
            "title": "ドラフトの更新",
            "description": "既存のメールドラフトを更新する"
          },
          "listDrafts": {
            "title": "ドラフト案リスト",
            "description": "すべての草案メールの一覧"
          },
          "deleteDraft": {
            "title": "草案を削除",
            "description": "草案のメールを削除する"
          },
          "sendDraft": {
            "title": "草案を送信",
            "description": "既存のメールの草稿を送信する"
          },
          "sendEmail": {
            "title": "メールを送信する",
            "description": "新しいメールを作成するか、既存のメッセージにすぐに返信してください。"
          },
          "getMailboxStats": {
            "title": "メールボックスの統計",
            "description": "フォルダの数とメールボックスの統計情報を取得する"
          }
        }
      },
      "googleCalendar": {
        "title": "Google カレンダー 連携機能",
        "description": "エージェントがGoogle Calendarとやり取りできるようにします - カレンダーの表示、イベントの取得、イベントの作成と更新、RSVPの管理。 <a>ドキュメントを読む</a>",
        "multiUserWarning": "Google カレンダーとの連携は、セキュリティ上の理由から、複数ユーザーモードでは利用できません。この機能をご利用いただくには、複数ユーザーモードを無効にする必要があります。",
        "configuration": "Google カレンダーの設定",
        "deploymentId": "デプロイメントID",
        "deploymentIdHelp": "あなたのGoogle Apps ScriptのウェブアプリケーションのデプロイID",
        "apiKey": "APIキー",
        "apiKeyHelp": "Google Apps Script のデプロイ時に設定した API キー",
        "configurationRequired": "Google カレンダーの機能を使用するために、デプロイメントIDとAPIキーを設定してください。",
        "configured": "設定済み",
        "searchSkills": "検索スキル...",
        "noSkillsFound": "あなたの検索条件に合致するスキルは見つかりませんでした。",
        "categories": {
          "calendars": {
            "title": "カレンダー",
            "description": "Googleカレンダーの表示と管理"
          },
          "readEvents": {
            "title": "イベント情報",
            "description": "カレンダー上のイベントの表示と検索"
          },
          "writeEvents": {
            "title": "イベントの作成と更新",
            "description": "新しいイベントを作成し、既存のイベントを修正する"
          },
          "rsvp": {
            "title": "RSVP（出欠確認）管理",
            "description": "イベントへの参加状況を管理する"
          }
        },
        "skills": {
          "listCalendars": {
            "title": "カレンダーリスト",
            "description": "所有している、または購読しているすべてのカレンダーの一覧"
          },
          "getCalendar": {
            "title": "カレンダーの詳細を確認する",
            "description": "特定のカレンダーに関する詳細な情報த்தைப்入手する"
          },
          "getEvent": {
            "title": "イベント情報を入手",
            "description": "特定のイベントに関する詳細な情報த்தைப்入手する"
          },
          "getEventsForDay": {
            "title": "その日のイベントを検索する",
            "description": "特定の日に予定されているすべてのイベントを取得する"
          },
          "getEvents": {
            "title": "イベント（期間指定）",
            "description": "指定した期間内のイベントを取得する"
          },
          "getUpcomingEvents": {
            "title": "今後のイベントをチェックする",
            "description": "今日、今週、または今月のイベントを、簡単なキーワードを使って検索する"
          },
          "quickAdd": {
            "title": "イベントをすぐに登録",
            "description": "自然言語（例：「明日午後3時に会議」）からイベントを作成する"
          },
          "createEvent": {
            "title": "イベントを作成する",
            "description": "すべてのプロパティを完全に制御できる、新しいイベントを作成する。"
          },
          "updateEvent": {
            "title": "イベント情報更新",
            "description": "既存の予定を更新する"
          },
          "setMyStatus": {
            "title": "返信状況を設定する",
            "description": "イベントへの参加、拒否、または仮の参加"
          }
        }
      },
      "ingest": {
        "title": "ドキュメント取り込み",
        "description": "エージェントが既にアップロードまたは解析済みのドキュメントを現在のワークスペースのナレッジベースに追加できるようにします。"
      }
    },
    "mcp": {
      "title": "MCP サーバー",
      "loading-from-config": "構成ファイルからMCPサーバーを読み込む",
      "learn-more": "MCP サーバーに関する詳細情報を入手してください。",
      "no-servers-found": "MCP サーバーは見つかりませんでした",
      "tool-warning": "最高のパフォーマンスを得るためには、不要なツールを無効にして、コンテキストを維持することを検討してください。",
      "stop-server": "MCP サーバーの停止",
      "start-server": "MCP サーバーを開始する",
      "delete-server": "MCP サーバーを削除",
      "tool-count-warning": "このMCPサーバーには<b>{{count}}個のツールが有効</b>になっており、毎回のチャットでコンテキストを消費します。<br />コンテキストを節約するには、不要なツールを無効にすることを検討してください。",
      "startup-command": "起動コマンド",
      "command": "指示",
      "arguments": "議論",
      "not-running-warning": "このMCPサーバーは稼働していません。停止しているか、起動時にエラーが発生している可能性があります。",
      "tool-call-arguments": "ツール呼び出しの引数",
      "tools-enabled": "ツールが有効化されました"
    },
    "settings": {
      "title": "エージェントのスキル設定",
      "max-tool-calls": {
        "title": "1回の応答で実行できる最大ツール数",
        "description": "エージェントが単一の応答を生成するために使用できるツールの一意な最大数。これにより、ツール呼び出しの過剰や無限ループを防ぐことができます。"
      },
      "intelligent-skill-selection": {
        "title": "知的なスキル選択",
        "beta-badge": "ベータ版",
        "description": "クエリごとに、無制限のツールを使用し、トークン使用量を最大80%削減できます。Athenaは、各プロンプトに対して最適なスキルを自動的に選択します。",
        "max-tools": {
          "title": "マックスツールズ",
          "description": "各クエリで選択できるツール数の上限。大規模なコンテキストモデルを使用する場合は、この値をより高い値に設定することをお勧めします。"
        }
      },
      "clarifying-questions": {
        "title": "エージェントの確認質問を許可",
        "beta-badge": "ベータ版",
        "description": "有効にすると、プロンプトが曖昧な場合にエージェントが短い確認質問をできます。",
        "limit-note": "1ターン最大3問、各質問は150文字までです。"
      }
    }
  },
  "recorded": {
    "title": "ワークスペースチャット履歴",
    "description": "ユーザーが送信したすべてのチャットとメッセージの履歴です。作成日時順に表示されます。",
    "export": "エクスポート",
    "table": {
      "id": "ID",
      "by": "送信者",
      "workspace": "ワークスペース",
      "prompt": "プロンプト",
      "response": "応答",
      "at": "送信日時"
    }
  },
  "api": {
    "title": "APIキー",
    "description": "APIキーにより、プログラム経由でこのAthenaインスタンスにアクセスおよび管理できます。",
    "link": "APIドキュメントを読む",
    "generate": "新しいAPIキーを生成",
    "empty": "APIキーが見つかりません",
    "actions": "操作",
    "messages": {
      "error": "エラー: {{error}}"
    },
    "modal": {
      "title": "新しいAPIキーを作成",
      "cancel": "キャンセル",
      "close": "閉じる",
      "create": "APIキーを作成",
      "helper": "作成したAPIキーは、このAthenaインスタンスにプログラムからアクセスして設定するために使用できます。",
      "name": {
        "label": "名前",
        "placeholder": "本番環境の統合",
        "helper": "任意です。後でこのキーを識別しやすい名前を付けてください。"
      }
    },
    "row": {
      "copy": "APIキーをコピー",
      "copied": "コピー済み",
      "unnamed": "--",
      "deleteConfirm": "このAPIキーを無効化してもよろしいですか？\n無効化すると、以後このキーは使用できなくなります。\n\nこの操作は元に戻せません。"
    },
    "table": {
      "name": "名前",
      "key": "APIキー",
      "by": "作成者",
      "created": "作成日"
    }
  },
  "llm": {
    "title": "LLMの設定",
    "description": "これは、お好みのLLMチャットおよび埋め込みプロバイダー用の認証情報と設定です。これらのキーが最新かつ正確でない場合、Athenaは正しく動作しません。",
    "provider": "LLMプロバイダー",
    "providers": {
      "azure_openai": {
        "azure_service_endpoint": "Azure サービス エンドポイント",
        "api_key": "APIキー",
        "chat_deployment_name": "チャットデプロイメント名",
        "chat_model_token_limit": "チャットモデルのトークン制限について\n\nチャットモデルのトークン制限について",
        "model_type": "モデルの種類",
        "default": "デフォルト",
        "reasoning": "理由",
        "model_type_tooltip": "もし、あなたのシステムが推論モデル（o1、o1-mini、o3-miniなど）を使用している場合、この設定を「推論」に設定してください。そうでない場合、チャットの要求が失敗する可能性があります。"
      }
    }
  },
  "search_model": {
    "title": "検索モデル設定",
    "description": "検索関連の推論と結果処理に使用するホスト型モデルを設定します。この設定は現在のWeb検索エンジンを変更しません。",
    "provider": "検索モデルプロバイダー",
    "providerHint": "ホスト型の検索モデルはデフォルトでは無効です。DashScope APIキーを用意した場合のみ阿里百錬を選択してください。",
    "providers": {
      "none": {
        "name": "なし",
        "description": "ホスト型の検索モデルを使用しません。検索モデルの呼び出しは未設定のままになります。"
      },
      "alibaba": {
        "name": "阿里百錬 DashScope",
        "description": "OpenAI-compatible API 経由で Alibaba Cloud DashScope の Qwen モデルを使用します。"
      }
    },
    "model": "検索モデル",
    "noneHelp": "ホスト型の検索モデルは呼び出されません。この設定はWeb検索エンジンプロバイダーとは独立しています。",
    "help": "阿里百錬の検索モデルは DashScope OpenAI-compatible エンドポイントを使用します。DashScope APIキー、Base URL、モデル名を入力してください。",
    "save": "変更を保存",
    "saving": "保存中...",
    "saved": "検索モデル設定を保存しました。",
    "saveError": "検索モデル設定の保存に失敗しました: {{error}}"
  },
  "vision": {
    "title": "視覚モデルの設定",
    "description": "視覚理解タスクに使用するホスト型の視覚モデルプロバイダーとモデルを設定します。",
    "provider": "視覚モデルプロバイダー",
    "providerHint": "ホスト型の視覚モデルはデフォルトでは無効です。DashScope APIキーを用意し、阿里百錬の視覚モデルを設定する場合のみ選択してください。",
    "providers": {
      "none": {
        "name": "なし",
        "description": "ホスト型の視覚モデルを使用しません。視覚理解の呼び出しは未設定のままになります。"
      },
      "alibaba": {
        "name": "阿里百錬 DashScope",
        "description": "Alibaba Cloud DashScope の Qwen VL モデルを視覚理解に使用します。"
      }
    },
    "model": "視覚モデル",
    "noneHelp": "ホスト型の視覚モデルは設定されていません。この設定はグローバルな視覚モデルの優先設定のみを管理し、OCRやチャットの動作を単独では変更しません。",
    "help": "阿里百錬の視覚モデルは DashScope OpenAI-compatible エンドポイントを使用します。DashScope APIキー、Base URL、モデル名を入力してください。",
    "toolToggle": {
      "label": "画像の事前分析を有効化",
      "description": "チャットメッセージに画像が含まれる場合、先に視覚モデルで分析し、その結果をメインチャットモデルへ渡します。",
      "disabledDescription": "オンのままでも構いませんが、阿里百錬を設定した後にのみ画像の事前分析が実行されます。"
    },
    "save": "変更を保存",
    "saving": "保存中...",
    "saved": "視覚モデル設定を保存しました。",
    "saveError": "視覚モデル設定の保存に失敗しました: {{error}}"
  },
  "provider_preset": {
    "title": "条件コードのインポート",
    "placeholder": "条件コードを入力",
    "apply": "設定を適用",
    "applying": "適用中...",
    "imported_status": "環境変数からインポートしました",
    "success_toast": "DeepSeek V4 Pro + Ali text-embedding-v4 + Ali 検索モデル + Ali OCR + Ali 視覚モデル設定を適用しました"
  },
  "transcription": {
    "title": "文字起こしモデルの設定",
    "description": "これは、お好みの文字起こしモデルプロバイダー用の認証情報と設定です。これらのキーが最新かつ正確でない場合、メディアファイルや音声が正しく文字起こしされません。",
    "provider": "文字起こしプロバイダー",
    "warn-start": "RAMやCPUが限られたマシンでローカルのWhisperモデルを使用すると、メディアファイルの処理中にAthenaが停止する可能性があります。",
    "warn-recommend": "少なくとも2GBのRAMが推奨され、ファイルサイズは10Mb未満であることをお勧めします。",
    "warn-end": "組み込みモデルは初回使用時に自動的にダウンロードされます。"
  },
  "embedding": {
    "title": "埋め込み設定",
    "desc-start": "LLMがネイティブに埋め込みエンジンをサポートしていない場合、テキストの埋め込み用に追加の認証情報を指定する必要がある場合があります。",
    "desc-end": "埋め込みとは、テキストをベクトルに変換するプロセスです。これらの認証情報は、ファイルやプロンプトをAthenaが処理できるフォーマットに変換するために必要です。",
    "provider": {
      "title": "埋め込みプロバイダー"
    },
    "document-mode": {
      "direct": {
        "title": "直接リアルタイム",
        "description": "ファイルはアップロード後すぐに埋め込まれます。高速ですが、リアルタイム埋め込みレートで課金されます。"
      },
      "batch": {
        "title": "バッチ非同期",
        "description": "ファイルは非同期バッチジョブとして送信されます。コストは低くなりますが、ドキュメントは完了後にのみ検索可能になります。"
      },
      "title": "ドキュメント埋め込みモード",
      "note": "この設定はドキュメントの取り込みとワークスペースの埋め込み再構築にのみ影響します。Athena Search と RAG クエリは常に直接リアルタイムの埋め込みを使用します。"
    }
  },
  "text": {
    "title": "テキスト分割とチャンク化の設定",
    "desc-start": "新しいドキュメントがベクトルデータベースに挿入される前に、どのように分割およびチャンク化されるかのデフォルトの方法を変更する場合があります。",
    "desc-end": "テキスト分割の仕組みとその副作用を理解している場合にのみ、この設定を変更するべきです。",
    "size": {
      "title": "テキストチャンクサイズ",
      "description": "1つのベクトルに含まれる最大の文字数です。",
      "recommend": "埋め込みモデルの最大長は"
    },
    "overlap": {
      "title": "テキストチャンクの重複",
      "description": "隣接するテキストチャンク間に発生する最大の重複文字数です。"
    }
  },
  "vector": {
    "title": "ベクターデータベース設定",
    "description": "これは、Athenaインスタンスの動作方法用の認証情報と設定です。これらのキーが最新で正確であることが重要です。",
    "provider": {
      "title": "ベクターデータベースプロバイダー",
      "description": "LanceDBの場合、特に設定は必要ありません。"
    }
  },
  "embeddable": {
    "title": "埋め込みチャットウィジェット",
    "description": "埋め込みチャットウィジェットは、特定のワークスペースに紐付けられた公開用チャットインターフェースです。これにより、ワークスペースを構築し、そのチャットを外部に公開できます。",
    "create": "埋め込みチャットウィジェットを作成",
    "table": {
      "workspace": "ワークスペース",
      "chats": "送信済みチャット",
      "active": "有効なドメイン",
      "created": "作成"
    }
  },
  "embed-chats": {
    "title": "埋め込みチャット履歴",
    "export": "エクスポート",
    "description": "これは、公開された埋め込みウィジェットから送信された全てのチャットとメッセージの記録です。",
    "table": {
      "embed": "埋め込み",
      "sender": "送信者",
      "message": "メッセージ",
      "response": "応答",
      "at": "送信日時"
    }
  },
  "event": {
    "title": "イベントログ",
    "description": "監視のために、このインスタンスで発生しているすべてのアクションとイベントを表示します。",
    "clear": "イベントログをクリア",
    "table": {
      "type": "イベントタイプ",
      "user": "ユーザー",
      "occurred": "発生日時"
    }
  },
  "privacy": {
    "title": "プライバシーとデータ処理",
    "description": "これは、接続されているサードパーティプロバイダーとAthenaがデータをどのように処理するかの設定です。",
    "anonymous": "匿名テレメトリが有効"
  },
  "connectors": {
    "search-placeholder": "データコネクタを検索",
    "no-connectors": "データコネクタが見つかりません。",
    "github": {
      "name": "GitHubリポジトリ",
      "description": "ワンクリックで公開・非公開のGitHubリポジトリ全体をインポートできます。",
      "URL": "GitHubリポジトリURL",
      "URL_explained": "収集したいGitHubリポジトリのURLです。",
      "token": "GitHubアクセストークン",
      "optional": "任意",
      "token_explained": "レート制限を回避するためのアクセストークンです。",
      "token_explained_start": "アクセストークンがない場合、",
      "token_explained_link1": "パーソナルアクセストークン",
      "token_explained_middle": "がないと、GitHub APIのレート制限により収集できるファイル数が制限される場合があります。 ",
      "token_explained_link2": "一時的なアクセストークンを作成",
      "token_explained_end": "してこの問題を回避できます。",
      "ignores": "無視するファイル",
      "git_ignore": ".gitignore形式で収集時に無視したいファイルをリストしてください。エンターキーで各エントリを保存します。",
      "task_explained": "完了後、すべてのファイルがドキュメントピッカーからワークスペースに埋め込めるようになります。",
      "branch": "収集したいブランチ",
      "branch_loading": "-- 利用可能なブランチを読み込み中 --",
      "branch_explained": "収集したいブランチを指定します。",
      "token_information": "<b>GitHubアクセストークン</b>を入力しない場合、GitHubの公開APIのレート制限により<b>トップレベル</b>のファイルのみ収集可能です。",
      "token_personal": "無料のパーソナルアクセストークンはこちらから取得できます。"
    },
    "gitlab": {
      "name": "GitLabリポジトリ",
      "description": "ワンクリックで公開・非公開のGitLabリポジトリ全体をインポートできます。",
      "URL": "GitLabリポジトリURL",
      "URL_explained": "収集したいGitLabリポジトリのURLです。",
      "token": "GitLabアクセストークン",
      "optional": "任意",
      "token_description": "GitLab APIから取得する追加エンティティを選択します。",
      "token_explained_start": "アクセストークンがない場合、",
      "token_explained_link1": "パーソナルアクセストークン",
      "token_explained_middle": "がないと、GitLab APIのレート制限により収集できるファイル数が制限される場合があります。 ",
      "token_explained_link2": "一時的なアクセストークンを作成",
      "token_explained_end": "してこの問題を回避できます。",
      "fetch_issues": "Issueをドキュメントとして取得",
      "ignores": "無視するファイル",
      "git_ignore": ".gitignore形式で収集時に無視したいファイルをリストしてください。エンターキーで各エントリを保存します。",
      "task_explained": "完了後、すべてのファイルがドキュメントピッカーからワークスペースに埋め込めるようになります。",
      "branch": "収集したいブランチ",
      "branch_loading": "-- 利用可能なブランチを読み込み中 --",
      "branch_explained": "収集したいブランチを指定します。",
      "token_information": "<b>GitLabアクセストークン</b>を入力しない場合、GitLabの公開APIのレート制限により<b>トップレベル</b>のファイルのみ収集可能です。",
      "token_personal": "無料のパーソナルアクセストークンはこちらから取得できます。"
    },
    "youtube": {
      "name": "YouTube文字起こし",
      "description": "YouTube動画の文字起こしをリンクからインポートできます。",
      "URL": "YouTube動画URL",
      "URL_explained_start": "文字起こしを取得したいYouTube動画のURLを入力してください。動画には",
      "URL_explained_link": "クローズドキャプション",
      "URL_explained_end": "が必要です。",
      "task_explained": "完了後、文字起こしがドキュメントピッカーからワークスペースに埋め込めるようになります。"
    },
    "website-depth": {
      "name": "ウェブサイト一括スクレイパー",
      "description": "ウェブサイトとその下層リンクを指定した深さまで取得します。",
      "URL": "ウェブサイトURL",
      "URL_explained": "取得したいウェブサイトのURLです。",
      "depth": "クロール深度",
      "depth_explained": "元のURLからたどる子リンクの数です。",
      "max_pages": "最大ページ数",
      "max_pages_explained": "取得する最大リンク数です。",
      "task_explained": "完了後、すべての取得内容がドキュメントピッカーからワークスペースに埋め込めるようになります。"
    },
    "confluence": {
      "name": "Confluence",
      "description": "ワンクリックでConfluenceページ全体をインポートできます。",
      "deployment_type": "Confluenceデプロイタイプ",
      "deployment_type_explained": "ConfluenceインスタンスがAtlassianクラウドかセルフホストかを選択します。",
      "base_url": "ConfluenceベースURL",
      "base_url_explained": "ConfluenceスペースのベースURLです。",
      "space_key": "Confluenceスペースキー",
      "space_key_explained": "使用するConfluenceインスタンスのスペースキーです。通常は~で始まります。",
      "username": "Confluenceユーザー名",
      "username_explained": "Confluenceのユーザー名です。",
      "auth_type": "Confluence認証タイプ",
      "auth_type_explained": "Confluenceページへアクセスするための認証タイプを選択してください。",
      "auth_type_username": "ユーザー名とアクセストークン",
      "auth_type_personal": "パーソナルアクセストークン",
      "token": "Confluenceアクセストークン",
      "token_explained_start": "認証用のアクセストークンを入力してください。アクセストークンは",
      "token_explained_link": "こちら",
      "token_desc": "認証用アクセストークン",
      "pat_token": "Confluenceパーソナルアクセストークン",
      "pat_token_explained": "Confluenceのパーソナルアクセストークンです。",
      "task_explained": "完了後、ページ内容がドキュメントピッカーからワークスペースに埋め込めるようになります。",
      "bypass_ssl": "SSL証明書の検証をスキップする",
      "bypass_ssl_explained": "これにより、独自の証明書で署名された、自社ホストのConfluenceインスタンスに対して、SSL証明書の検証を回避できます。"
    },
    "manage": {
      "documents": "ドキュメント",
      "data-connectors": "データコネクタ",
      "desktop-only": "これらの設定の編集はデスクトップ端末のみ対応しています。デスクトップでこのページにアクセスしてください。",
      "dismiss": "閉じる",
      "editing": "編集中"
    },
    "directory": {
      "my-documents": "マイドキュメント",
      "new-folder": "新しいフォルダー",
      "create-folder-title": "新しいフォルダーを作成",
      "folder-name": "フォルダー名",
      "folder-name-placeholder": "フォルダー名を入力",
      "cancel-create-folder": "キャンセル",
      "create-folder": "フォルダーを作成",
      "creating-folder": "作成中...",
      "create-folder-error": "フォルダーの作成に失敗しました。",
      "close-create-folder": "フォルダー作成ダイアログを閉じる",
      "search-document": "ドキュメントを検索",
      "no-documents": "ドキュメントがありません",
      "move-workspace": "ワークスペースへ移動",
      "delete-confirmation": "これらのファイルやフォルダーを削除してもよろしいですか？\nシステムから削除され、既存のワークスペースからも自動的に削除されます。\nこの操作は元に戻せません。",
      "removing-message": "{{count}}件のドキュメントと{{folderCount}}件のフォルダーを削除中です。しばらくお待ちください。",
      "move-success": "{{count}}件のドキュメントを移動しました。",
      "no_docs": "ドキュメントがありません",
      "select_all": "すべて選択",
      "deselect_all": "すべて選択解除",
      "remove_selected": "選択したものを削除",
      "save_embed": "保存して埋め込む",
      "total-documents_one": "{{count}} のドキュメント",
      "total-documents_other": "{{count}} に関する書類"
    },
    "upload": {
      "processor-offline": "ドキュメント処理機能が利用できません",
      "processor-offline-desc": "ドキュメント処理機能がオフラインのため、ファイルをアップロードできません。後でもう一度お試しください。",
      "click-upload": "クリックしてアップロード、またはドラッグ＆ドロップしてください",
      "cancel-upload": "アップロードを停止",
      "preparing-upload": "{{percent}}% · アップロードを準備中",
      "upload-progress": "{{percent}}% · {{speed}}/秒",
      "upload-complete": "100% · アップロード完了",
      "upload-failed": "ファイルのアップロードに失敗しました",
      "file-types": "テキストファイル、CSV、スプレッドシート、音声ファイルなどに対応しています！",
      "or-submit-link": "またはリンクを入力",
      "placeholder-link": "https://example.com",
      "fetching": "取得中...",
      "fetch-website": "ウェブサイトを取得",
      "privacy-notice": "これらのファイルは、このAthenaインスタンス上のドキュメント処理機能にアップロードされます。第三者に送信・共有されることはありません。"
    },
    "document-status": {
      "uploading": "アップロード中",
      "waiting": "処理待ち",
      "processing": "解析中",
      "embedding": "埋め込み中",
      "indexing": "インデックス作成中",
      "uploaded": "アップロード済み",
      "indexed": "インデックス済み",
      "outdated": "インデックス期限切れ",
      "failed": "処理に失敗",
      "cancelled": "キャンセル済み",
      "cached": "キャッシュ済み",
      "last-indexed": "最終インデックス：{{value}}",
      "embedding-count": "埋め込み数：{{count}}",
      "batch-id": "バッチ ID：{{value}}",
      "failure-reason": "失敗理由：{{value}}",
      "remove-from-queue": "キューから削除"
    },
    "pinning": {
      "what_pinning": "ドキュメントのピン留めとは？",
      "pin_explained_block1": "Athenaでドキュメントを<b>ピン留め</b>すると、その内容全体がプロンプトウィンドウに挿入され、LLMがしっかり理解できるようになります。",
      "pin_explained_block2": "<b>大きなコンテキストを持つモデル</b>や、重要な小さなファイルで特に効果的です。",
      "pin_explained_block3": "デフォルトのままでは満足できる回答が得られない場合、ピン留めを活用するとより高品質な回答が得られます。",
      "accept": "わかりました"
    },
    "watching": {
      "what_watching": "ドキュメントのウォッチとは？",
      "watch_explained_block1": "Athenaでドキュメントを<b>ウォッチ</b>すると、元のソースから定期的に内容が<i>自動的に</i>同期されます。管理しているすべてのワークスペースで内容が自動更新されます。",
      "watch_explained_block2": "この機能は現在オンラインベースのコンテンツのみ対応しており、手動アップロードしたドキュメントには利用できません。",
      "watch_explained_block3_start": "ウォッチしているドキュメントの管理は",
      "watch_explained_block3_link": "ファイルマネージャー",
      "watch_explained_block3_end": "管理画面から行えます。",
      "accept": "わかりました"
    },
    "obsidian": {
      "vault_location": "保管場所",
      "vault_description": "Obsidianの vault フォルダを選択して、すべてのメモとそれらの関連をインポートします。",
      "selected_files": "マークダウン形式のファイルが見つかりました：{{count}}個",
      "importing": "保管庫のインポート...",
      "import_vault": "保管庫をインポート",
      "processing_time": "これは、保管場所のサイズによって時間がかかる可能性があります。",
      "vault_warning": "いかなる紛争を避けるため、Obsidianの保管場所が現在開いている状態でないことを確認してください。"
    }
  },
  "chat_window": {
    "send_message": "メッセージを送信",
    "attach_file": "このチャットにファイルをアップロードまたは添付します。",
    "controls": {
      "upload": {
        "label": "アップロード",
        "description": "ファイルをアップロードまたは添付します。画像はこのチャット内で使用され、対応文書はワークスペース知識として索引化できます。",
        "workspaceLabel": "文書をアップロード",
        "workspaceDescription": "文書をこのワークスペースにアップロードし、Athena が後で整理、検索、参照できるようにします。"
      },
      "quizMode": {
        "label": "テスト",
        "description": "テストモードを有効にします。次のメッセージで Athena がクイズ形式の質問を作成します。",
        "activeDescription": "テストモードが有効です。次のメッセージでクイズ形式の質問を作成します。"
      },
      "fileAccess": {
        "label": "ファイルアクセスモード",
        "globalDefault": "グローバル既定",
        "modes": {
          "sandbox": {
            "label": "サンドボックスモード",
            "description": "プロジェクトワークスペース内のファイルにのみアクセスできます。"
          },
          "authorized": {
            "label": "承認済みモード",
            "description": "デスクトップ、書類、ダウンロードなど、承認済みのローカルフォルダにアクセスできます。"
          },
          "open": {
            "label": "完全オープンモード",
            "description": "承認後、広範なローカルファイルとターミナルへのアクセスを許可します。注意して使用してください。"
          }
        },
        "openConfirm": {
          "title": "完全オープンのファイルアクセスを有効にしますか？",
          "description": "完全オープンモードでは、より広範なローカルファイルアクセスが許可され、承認後に shell コマンドを実行できる場合があります。",
          "confirm": "続行"
        }
      }
    },
    "text_size": "テキストサイズを変更",
    "microphone": "プロンプトを音声入力",
    "send": "ワークスペースにプロンプトメッセージを送信",
    "attachments_processing": "添付ファイルの処理中です。しばらくお待ちください。",
    "tts_speak_message": "TTS Speak メッセージ",
    "copy": "以下に翻訳を示します。",
    "regenerate": "再生",
    "regenerate_response": "申し訳ありませんが、その質問にはお答えできません。",
    "good_response": "良い反応",
    "more_actions": "さらに詳細な情報が必要な場合は、お気軽にお問い合わせください。",
    "metrics_visibility": {
      "hover_only": "クリックするとモデル情報をホバー時のみ表示します",
      "always_show": "クリックするとモデル情報を常に表示します",
      "unknown_model": "モデル不明"
    },
    "fork": "フォーク",
    "delete": "削除",
    "cancel": "キャンセル",
    "edit_prompt": "編集のヒント",
    "edit_response": "編集内容を保存します。",
    "preset_reset_description": "チャット履歴をクリアし、新しいチャットを開始してください。",
    "add_new_preset": "新しいプリセットを追加する",
    "command": "命令",
    "your_command": "あなたの指示",
    "placeholder_prompt": "これは、プロンプトの先頭に挿入されるコンテンツです。",
    "description": "説明",
    "placeholder_description": "大規模言語モデルに関する詩を提示します。",
    "save": "保存",
    "compact": "コンパクト",
    "small": "小さい",
    "normal": "通常",
    "comfortable": "快適",
    "large": "大規模",
    "xlarge": "特大",
    "custom": "カスタム",
    "custom_text_size": "カスタム文字サイズ",
    "workspace_llm_manager": {
      "search": "LLMプロバイダーを検索する",
      "loading_workspace_settings": "作業スペースの設定を読み込んでいます...",
      "available_models": "{{provider}} の利用可能なモデル",
      "available_models_description": "このワークスペースで使用するモデルを選択してください。",
      "save": "このモデルを使用してください。",
      "saving": "デフォルトワークスペースとしてモデルを設定...",
      "missing_credentials": "このプロバイダーには資格がありません。",
      "missing_credentials_description": "認証情報を設定するには、ここをクリックしてください。"
    },
    "submit": "送信",
    "edit_info_user": "「送信」はAIの応答を再生成します。「保存」は、あなたのメッセージのみを更新します。",
    "edit_info_assistant": "あなたの変更は、この回答に直接保存されます。",
    "see_less": "詳細を見る",
    "see_more": "詳細を見る",
    "tools": "道具",
    "text_size_label": "文字サイズ",
    "select_model": "モデルを選択",
    "sources": "出典",
    "document": "文書",
    "similarity_match": "試合",
    "source_count_one": "{{count}} 参照",
    "source_count_other": "{{count}} への参照",
    "preset_exit_description": "現在のエージェントセッションを停止する",
    "add_new": "新しいものを追加する",
    "edit": "編集",
    "publish": "出版",
    "stop_generating": "応答の生成を停止する",
    "slash_commands": "スラッシュコマンド",
    "agent_skills": "エージェントのスキル",
    "manage_agent_skills": "エージェントのスキル管理",
    "agent_skills_disabled_in_session": "アクティブなセッション中にスキルを変更することはできません。まず、`/exit`コマンドを使用してセッションを終了してください。",
    "start_agent_session": "エージェントセッションを開始",
    "use_agent_session_to_use_tools": "チャットでツールを使用するには、プロンプトの冒頭に'@agent'を使用してエージェントセッションを開始してください。",
    "turnState": {
      "reconnecting": "再接続しています…",
      "saving": "安全に保存しています…",
      "saveRetrying": "返信は保持されています。安全な保存をバックグラウンドで再試行します。",
      "loadingFullResponse": "返信全体を読み込んでいます…",
      "retryFullResponse": "返信全体の読み込みを再試行",
      "loadFullResponse": "返信全体を読み込む",
      "loadingConversation": "会話を読み込んでいます",
      "responseFailed": "このメッセージに応答できませんでした。",
      "reconnectLimitPrompt": "エージェントの再接続上限に達しました。記録済みのツール結果と途中までの返信を使って続行しますか？",
      "reconnect": "再接続",
      "keepInterrupted": "中断したままにする",
      "errorReason": "理由：",
      "unknownError": "不明なエラー"
    },
    "toolTimeline": {
      "modelThinking": "モデルが思考中…",
      "modelComplete": "モデルの思考が完了しました",
      "agentThinking": "エージェントが思考中...",
      "agentComplete": "エージェントの思考が完了しました",
      "progress": {
        "runningSummary": "{{phase}} · {{count}} ステップ完了 · {{elapsed}} {{stillWorking}}",
        "completedSummary": "エージェント完了 · {{count}} ステップ · 証拠 {{evidence}} 件 · {{elapsed}}",
        "failedSummary": "{{phase}}に失敗 · {{count}} ステップ完了 · {{elapsed}}",
        "stillWorking": "· このステップを引き続き実行中",
        "toolDetail": "{{tool}} を呼び出しています",
        "evidenceDetail": "証拠 {{count}} 件を取得しました",
        "approvalDetail": "{{tool}} の承認を要求しました",
        "clarificationDetail": "追加情報を取得しました",
        "phases": {
          "routing": "エージェント経路を判定しています",
          "session_start": "エージェントモードに入っています",
          "tool_selection": "利用可能なツールを選択しています",
          "tool_execution": "ツールを呼び出しています",
          "retrieval": "ワークスペース資料を検索しています",
          "evidence_ready": "検索証拠を取得しました",
          "synthesis": "証拠に基づいて回答を整理しています",
          "finalizing": "回答を仕上げています"
        }
      },
      "showThoughtChain": "思考チェーンを表示",
      "hideThoughtChain": "思考チェーンを非表示",
      "agentSessionStarted": "エージェントモードを開始しました。/exit を入力するとセッションを終了できます。",
      "agentTemporarilyUnavailable": "エージェントサービスは一時的に利用できません。メッセージは保持されています。しばらくしてから再試行してください。",
      "agentFallbackToChat": "指定されたエージェント{{targets}}を開始できませんでした。通常のチャットとして続行します。",
      "agentTargetLabel": "（{{targets}}）",
      "reconnecting": "エージェントの接続が中断されました。再接続しています（{{attempt}}/{{total}}）…",
      "generationStopped": "生成を停止しました。",
      "agentSessionUnavailable": "このエージェントセッションは新しい入力を受け付けていません。",
      "agentFollowUpSent": "実行中のエージェントセッションに追加の入力を送信しました。",
      "streamAborted": "返信ストリームが中断されました。",
      "websocketFailed": "リアルタイム接続に失敗しました。",
      "reconnectFailed": "エージェントを再接続できませんでした。",
      "chatStreamFailed": "返信が完了する前にチャットストリームが中断されました。",
      "approvalRequested": "{{skill}} の承認が必要です",
      "agentError": "エージェントエラー",
      "toolFallback": "ツール",
      "toolFamilyLabel": "{{family}}（{{toolName}}）",
      "actionPrefix": "操作: {{action}} · ",
      "status": {
        "calling": "呼び出し中",
        "returned": "返却済み",
        "errored": "エラー",
        "working": "処理中...",
        "finished": "完了しました。"
      },
      "templates": {
        "assemblingToolCall": "ツール呼び出しを組み立て中: {{tool}} {{args}}",
        "parsedToolCall": "ツール呼び出しを解析済み: {{tool}} {{args}}",
        "toolCall": "ツール呼び出し: {{tool}} {{args}}",
        "executingTool": "@agent が {{tool}} ツールを実行中 {{args}}",
        "contextFound": "@agent が回答に役立つ追加コンテキストを {{count}} 件見つけました。",
        "toolReturned": "{{tool}}が結果を返しました。",
        "callingTool": "{{tool}} を呼び出し中..."
      },
      "tools": {
        "rag-memory": "ナレッジメモリ",
        "document-ingest-agent": "ドキュメント取り込みツール",
        "document-summarizer": "ドキュメント要約ツール",
        "web-browsing": "Web ブラウジングツール",
        "web-scraping": "Web スクレイピングツール",
        "chat-history": "チャット履歴",
        "file-history": "ファイル履歴",
        "shell-agent": "シェルツール",
        "create-chart": "チャート作成ツール",
        "sql-agent": "SQL ツール"
      },
      "toolFamilies": {
        "filesystem": "ファイルシステムツール",
        "create": "ファイル作成ツール",
        "gmail": "Gmail ツール",
        "outlook": "Outlook ツール",
        "gcal": "Google カレンダーツール",
        "sql": "SQL ツール"
      },
      "actions": {
        "search": "検索",
        "store": "保存",
        "read": "読み取り",
        "write": "書き込み",
        "create": "作成",
        "update": "更新",
        "delete": "削除",
        "list": "一覧表示",
        "get": "取得",
        "send": "送信",
        "reply": "返信",
        "move": "移動",
        "mark": "マーク",
        "query": "クエリ"
      }
    },
    "agent_invocation": {
      "model_wants_to_call": "モデルは電話をかけたい。",
      "approve": "承認",
      "reject": "拒否",
      "always_allow": "常に、{{skillName}}を確保してください。",
      "tool_call_was_approved": "ツールの使用許可が承認されました",
      "tool_call_was_rejected": "ツール呼び出しは拒否されました",
      "clarifying_skip": "エージェントに任せる",
      "clarifying_submit": "送信",
      "clarifying_skipped": "エージェントに判断を委ねました。",
      "clarifying_timeout": "時間内に回答が送信されませんでした。",
      "clarifying_pagination": "{{current}} / {{total}}",
      "clarifying_prev_aria": "前の質問",
      "clarifying_next_aria": "次の質問",
      "clarifying_close_aria": "閉じてスキップ",
      "clarifying_other": "その他",
      "clarifying_other_placeholder": "回答を入力",
      "clarifying_recommended": "おすすめ",
      "clarifying_backup": "代替案",
      "clarifying_send_failed": "回答を送信できませんでした。もう一度お試しください。",
      "batch_progress": "{{answered}} / {{total}} 回答済み",
      "batch_skip_this": "スキップ",
      "batch_submit_all": "すべて送信",
      "batch_next": "次へ",
      "answer_skipped": "スキップ済み"
    },
    "custom_skills": "カスタマイズ可能なスキル",
    "agent_flows": "エージェント間の流れ",
    "no_tools_found": "一致するツールは見つかりませんでした",
    "loading_mcp_servers": "MCP サーバーの読み込み中...",
    "app_integrations": "アプリケーション連携",
    "sub_skills": "専門スキル",
    "ocr_processing": "OCR認識を処理しています。お待ちください..."
  },
  "profile_settings": {
    "edit_account": "アカウントを編集",
    "profile_picture": "プロフィール画像",
    "remove_profile_picture": "プロフィール画像を削除",
    "username": "ユーザー名",
    "new_password": "新しいパスワード",
    "password_description": "パスワードは8文字以上である必要があります",
    "cancel": "キャンセル",
    "update_account": "アカウントを更新",
    "theme": "テーマ設定",
    "language": "優先言語",
    "failed_upload": "プロフィール写真のアップロードに失敗しました：{{error}}",
    "upload_success": "プロフィール写真がアップロードされました。",
    "failed_remove": "プロフィール写真の削除に失敗しました：{{error}}",
    "profile_updated": "プロフィールを更新しました。",
    "failed_update_user": "ユーザーの更新に失敗：{{error}}",
    "account": "アカウント",
    "support": "サポート",
    "signout": "ログアウト",
    "signout_confirm_title": "ログアウトしますか？",
    "signout_confirm_description": "このデバイスの現在のセッションが消去されます。後で再度ログインできます。",
    "signout_confirm_action": "ログアウト",
    "email": "メールアドレス",
    "email-verified": "確認済み",
    "email-pending": "確認待ち",
    "email-unbound": "未連携",
    "email-bind-hint": "確認コードを受け取るためのメールアドレスを入力してください。",
    "email-change-hint": "新しいメールアドレスを入力して確認コードを受け取ってください。",
    "email-required": "メールアドレスが必要です。",
    "email-code-sent": "確認コードを送信しました。",
    "email-verified-success": "メールアドレスが確認されました。",
    "change-email": "メールアドレスを変更",
    "send-verification-code": "確認コードを送信",
    "resend-verification-code-in": "あと{{seconds}}秒で再送信",
    "processing": "処理中..."
  },
  "customization": {
    "interface": {
      "title": "UI設定",
      "description": "Athena の UI 設定を調整してください。"
    },
    "branding": {
      "title": "ブランディングとホワイトレーベル化",
      "description": "Athenaインスタンスを、独自のブランドでカスタマイズしてください。"
    },
    "chat": {
      "title": "チャット",
      "description": "Athena のチャット設定をカスタマイズしてください。",
      "auto_submit": {
        "title": "自動音声入力送信",
        "description": "沈黙の後に自動で音声入力を行う"
      },
      "auto_speak": {
        "title": "自動応答機能",
        "description": "AIによる自動応答"
      },
      "spellcheck": {
        "title": "スペルチェック機能を有効にする",
        "description": "チャット入力フィールドでのスペルチェックを有効または無効にする"
      }
    },
    "items": {
      "theme": {
        "title": "テーマ",
        "description": "アプリケーションの希望の色テーマを選択してください。",
        "options": {
          "system": "システム",
          "light": "ライト",
          "dark": "ダーク"
        }
      },
      "show-scrollbar": {
        "title": "スクロールバーを表示する",
        "description": "チャットウィンドウのスクロールバーを有効または無効にする。"
      },
      "support-email": {
        "title": "サポートメール",
        "description": "ユーザーが支援を必要とする際に利用できる、サポート用メールアドレスを設定します。"
      },
      "app-name": {
        "title": "名前",
        "description": "ログインページに表示される名前を、すべてのユーザーに設定する。"
      },
      "display-language": {
        "title": "表示言語",
        "description": "AthenaのUIを特定の言語で表示するためのオプションを選択してください。翻訳が利用可能な場合にのみ有効です。"
      },
      "logo": {
        "title": "ブランドロゴ",
        "description": "すべてのページで表示するためのカスタムロゴをアップロードしてください。",
        "add": "カスタムロゴを追加する",
        "recommended": "推奨サイズ：800 x 200",
        "remove": "削除",
        "replace": "置き換える"
      },
      "browser-appearance": {
        "title": "ブラウザの見た目",
        "description": "アプリを開いたときに、ブラウザのタブとタイトルをカスタマイズする。",
        "tab": {
          "title": "タイトル",
          "description": "ブラウザでアプリを開いたときに、カスタムのタブタイトルを設定します。"
        },
        "favicon": {
          "title": "ファビコン",
          "description": "ブラウザのタブにカスタムのfaviconを使用する。"
        }
      },
      "sidebar-footer": {
        "title": "サイドバーのフッター項目",
        "description": "サイドバーの下部に表示されるフッターの項目をカスタマイズする。",
        "icon": "アイコン",
        "link": "リンク"
      },
      "render-html": {
        "title": "チャットでHTMLをレンダリングする",
        "description": "アシスタントの回答にHTML形式のレスポンスを生成する。\nこれにより、回答の品質を大幅に向上させることができるが、同時にセキュリティ上のリスクも生じる可能性がある。"
      },
      "motion-density": {
        "guide": {
          "title": "速度ガイド",
          "description": "移動するドットがリズムをプレビューします。移動距離が短いほど落ち着いて速く感じられ、長いほど豊かで目立つように感じられます。"
        },
        "options": {
          "minimal": {
            "label": "ミニマル",
            "description": "最も控えめなインターフェースのための、短く落ち着いたモーション。",
            "speed": "速く控えめ",
            "duration": "約0.28秒"
          },
          "balanced": {
            "label": "バランス",
            "description": "デフォルトの製品リズム：洗練され、安定し、静か。",
            "speed": "標準リズム",
            "duration": "約0.36秒"
          },
          "expressive": {
            "label": "表現豊か",
            "description": "パフォーマンス予算内で、やや豊かなモーション。",
            "speed": "より遅く豊か",
            "duration": "約0.48秒"
          }
        },
        "title": "モーションの密度",
        "description": "ルート、パネル、モーダル、マイクロインタラクション全体のアニメーションの強さと速度を制御します。"
      }
    }
  },
  "main-page": {
    "quickActions": {
      "createAgent": "エージェントを作成する",
      "editWorkspace": "ワークスペースの編集",
      "uploadDocument": "ドキュメントをアップロードする"
    },
    "greeting": "今日はどのようにお手伝いできますか？"
  },
  "keyboard-shortcuts": {
    "title": "キーボードショートカット",
    "shortcuts": {
      "settings": "設定を開く",
      "workspaceSettings": "現在のワークスペースの設定を開く",
      "home": "ホームページへ",
      "workspaces": "ワークスペースの管理",
      "apiKeys": "APIキーの設定",
      "llmPreferences": "LLM の好み",
      "chatSettings": "チャット設定",
      "help": "キーボードショートカットのヘルプを表示する",
      "showLLMSelector": "LLM（大規模言語モデル）選択ツール"
    }
  },
  "community_hub": {
    "publish": {
      "system_prompt": {
        "success_title": "成功！",
        "success_description": "システムプロンプトがコミュニティハブに公開されました。",
        "success_thank_you": "コミュニティへの共有ありがとうございます。",
        "view_on_hub": "コミュニティハブでの表示",
        "modal_title": "出版システムに関するプロンプト",
        "name_label": "名前",
        "name_description": "これは、システムのプロンプトの名前です。",
        "name_placeholder": "私のシステムプロンプト",
        "description_label": "説明",
        "description_description": "これは、システムプロンプトの説明です。システムプロンプトの目的を説明するために使用してください。",
        "tags_label": "タグ",
        "tags_description": "タグは、システムプロンプトを簡単に検索できるようにラベル付けするために使用されます。複数のタグを追加できます。最大5つのタグ。各タグは最大20文字です。",
        "tags_placeholder": "タグを追加するには、タイプしてEnterキーを押してください。",
        "visibility_label": "視界",
        "public_description": "一般のシステムからのメッセージは、すべての人に表示されます。",
        "private_description": "プライベートなシステムからのメッセージは、あなただけが見ることができます。",
        "publish_button": "コミュニティハブに公開する",
        "submitting": "出版...",
        "prompt_label": "プロンプト",
        "prompt_description": "これは、大規模言語モデル（LLM）を誘導するために使用される実際のシステムプロンプトです。",
        "prompt_placeholder": "ここにシステムプロンプトを入力してください..."
      },
      "agent_flow": {
        "success_title": "成功！",
        "success_description": "あなたのエージェントフローがコミュニティハブに公開されました。",
        "success_thank_you": "コミュニティへの共有ありがとうございます。",
        "view_on_hub": "コミュニティハブで確認",
        "modal_title": "出版代理店フロー",
        "name_label": "山田太郎\n\n\n氏名\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n\n名前\n山田 太郎\n<|im",
        "name_description": "これは、あなたのエージェントフローの名前です。",
        "name_placeholder": "私のエージェントフロー",
        "description_label": "説明",
        "description_description": "これは、あなたのエージェントフローの説明です。この説明文を使って、あなたのエージェントフローの目的を記述してください。",
        "tags_label": "タグ",
        "tags_description": "タグは、ワークフローをより簡単に検索するために使用されます。複数のタグを追加できます。最大5つのタグ。各タグは最大20文字です。",
        "tags_placeholder": "タグを追加するには、タイプしてEnterキーを押してください。",
        "visibility_label": "視界",
        "submitting": "出版...",
        "submit": "コミュニティハブに公開する",
        "privacy_note": "機密性の高いデータ保護のため、ワークフローは常にプライベートでアップロードされます。公開後、コミュニティハブで可視性を変更できます。公開前に、ワークフローに機密情報や個人情報が含まれていないことを確認してください。"
      },
      "generic": {
        "unauthenticated": {
          "title": "本人確認が必要です。",
          "description": "アイテムを公開する前に、Athenaコミュニティハブで認証する必要があります。",
          "button": "コミュニティハブへの接続"
        }
      },
      "slash_command": {
        "success_title": "成功！",
        "success_description": "スラッシュコマンドがコミュニティハブに公開されました。",
        "success_thank_you": "コミュニティへの共有ありがとうございます。",
        "view_on_hub": "コミュニティハブでの表示",
        "modal_title": "スラッシュコマンドを公開する",
        "name_label": "名前",
        "name_description": "これは、スラッシュコマンドの名前です。",
        "name_placeholder": "私のスラッシュコマンド",
        "description_label": "説明",
        "description_description": "これは、スラッシュコマンドの説明です。スラッシュコマンドの目的を記述するために使用してください。",
        "tags_label": "タグ",
        "tags_description": "スラッシュコマンドをより簡単に検索できるように、タグを使用してコマンドを分類します。複数のタグを追加できます。最大5つのタグ。各タグは最大20文字です。",
        "tags_placeholder": "タグを追加するには、タイプしてEnterキーを押してください。",
        "visibility_label": "視界",
        "public_description": "一般のユーザーが利用できるコマンドは、すべての人に公開されています。",
        "private_description": "私だけが利用できるプライベートなスラッシュコマンドのみが表示されます。",
        "publish_button": "コミュニティハブに公開する",
        "submitting": "出版...",
        "prompt_label": "どのような状況で、どのような目的で、どのような方法で、どのような結果を期待していますか？",
        "prompt_description": "これは、スラッシュコマンドが実行されたときに使用されるプロンプトです。",
        "prompt_placeholder": "ここに指示を入力してください..."
      }
    }
  },
  "security": {
    "title": "セキュリティ",
    "multiuser": {
      "title": "マルチユーザーモード",
      "description": "マルチユーザーモードを有効にして、チームをサポートするようにインスタンスを設定します。",
      "enable": {
        "is-enable": "マルチユーザーモードが有効です",
        "enable": "マルチユーザーモードを有効にする",
        "description": "デフォルトでは、あなたが唯一の管理者になります。管理者として、すべての新しいユーザーまたは管理者のアカウントを作成する必要があります。管理者ユーザーのみがパスワードをリセットできるため、パスワードを紛失しないでください。",
        "username": "管理者アカウントのユーザー名",
        "password": "管理者アカウントのパスワード"
      }
    },
    "password": {
      "title": "パスワード保護",
      "description": "Athenaインスタンスをパスワードで保護します。これを忘れた場合、回復方法はないため、このパスワードを必ず保存してください。",
      "password-label": "インスタンスパスワード"
    }
  },
  "home": {
    "welcome": "ようこそ",
    "chooseWorkspace": "ワークスペースを選択してチャットを開始してください！",
    "notAssigned": "現在、あなたはどのワークスペースにも割り当てられていません。\nワークスペースへのアクセスを要求するには、管理者にお問い合わせください。",
    "goToWorkspace": "ワークスペースに移動 \"{{workspace}}\""
  },
  "telegram": {
    "title": "テレグラムボット",
    "description": "AnyLLM のインスタンスを Telegram に接続することで、あらゆるデバイスからワークスペースとのチャットが可能になります。",
    "setup": {
      "step1": {
        "title": "ステップ1：Telegramボットを作成する",
        "description": "Telegramで@BotFatherを開き、<code>/newbot</code>を<code>@BotFather</code>に送信し、プロンプトに従って、APIトークンをコピーします。",
        "open-botfather": "BotFather を起動する",
        "instruction-1": "1. リンクを開くか、QRコードをスキャンする",
        "instruction-2": "2. <code>/newbot</code>を<code>@BotFather</code>に送信します。",
        "instruction-3": "3. 独自の名前とユーザー名をボットに設定してください",
        "instruction-4": "4. 受け取ったAPIトークンをコピーしてください"
      },
      "step2": {
        "title": "ステップ2：ボットとの接続",
        "description": "@BotFatherから受け取ったAPIトークンを貼り付け、ボットとのチャットに使用するデフォルトのワークスペースを選択してください。",
        "bot-token": "ボット トークン",
        "connecting": "接続中...",
        "connect-bot": "コネクトボット"
      },
      "security": {
        "title": "推奨されるセキュリティ設定",
        "description": "追加のセキュリティのため、@BotFatherでこれらの設定を設定してください。",
        "disable-groups": "— グループへのボットの追加を防止",
        "disable-inline": "— インライン検索でのボットの使用を防止",
        "obscure-username": "目立たないユーザー名をbotに使用することで、発見されにくくする。"
      },
      "toast-enter-token": "ボットのトークンを入力してください。",
      "toast-connect-failed": "ボットとの接続に失敗しました。"
    },
    "connected": {
      "status": "接続されている",
      "status-disconnected": "通信エラー - トークンが無効または期限切れになっている可能性があります",
      "placeholder-token": "新しいボットのトークンを貼り付け...",
      "reconnect": "再接続",
      "workspace": "作業スペース",
      "bot-link": "ボットへのリンク",
      "voice-response": "音声応答",
      "disconnecting": "接続を解除...",
      "disconnect": "接続を解除する",
      "voice-text-only": "テキストのみ",
      "voice-mirror": "（ユーザーが音声で送信した場合、音声で返信）",
      "voice-always": "常に音声メッセージ（返信ごとに音声データを送信）",
      "toast-disconnect-failed": "ボットとの接続を解除できませんでした。",
      "toast-reconnect-failed": "ボットとの再接続に失敗しました。",
      "toast-voice-failed": "音声モードの更新に失敗しました。",
      "toast-approve-failed": "ユーザーの承認に失敗しました。",
      "toast-deny-failed": "ユーザーからの拒否を拒否できませんでした。",
      "toast-revoke-failed": "ユーザーの権限停止に失敗。"
    },
    "users": {
      "pending-description": "本人情報の確認待ちのユーザー。ここに表示されているペアリングコードを、彼らがTelegramで表示しているコードと照合してください。",
      "unknown": "不明"
    }
  },
  "admin": {
    "common": {
      "genericError": "エラー: {{error}}",
      "close": "閉じる"
    },
    "users": {
      "title": "ユーザー",
      "description": "これはこのインスタンスに登録済みのアカウント一覧です。アカウントを削除すると、このインスタンスへのアクセスが即座に取り消されます。",
      "add": "ユーザー追加",
      "table": {
        "username": "ユーザー名",
        "role": "ロール",
        "dateAdded": "作成日"
      },
      "roles": {
        "default": "一般ユーザー",
        "manager": "マネージャー",
        "admin": "管理者"
      },
      "permissions": {
        "title": "権限",
        "default": [
          "管理者またはマネージャーが追加したワークスペースでのみチャットを送信できます。",
          "設定は一切変更できません。"
        ],
        "manager": [
          "任意のワークスペースを表示・作成・削除でき、ワークスペース固有の設定を変更できます。",
          "新しいユーザーを作成・更新・招待できます。",
          "LLM、ベクトル DB、埋め込み、他の接続は変更できません。"
        ],
        "admin": [
          "最高レベルのユーザー権限です。",
          "システム全体の操作が可能です。"
        ]
      },
      "messageLimit": {
        "label": "1日のメッセージ数を制限",
        "description": "このユーザーを、24 時間内の成功クエリまたはチャット数に制限します。",
        "inputLabel": "1日のメッセージ上限"
      },
      "actions": {
        "add": "ユーザー追加",
        "cancel": "キャンセル",
        "update": "ユーザー更新",
        "edit": "編集",
        "unsuspend": "再開",
        "suspend": "停止",
        "delete": "削除"
      },
      "modal": {
        "addTitle": "インスタンスにユーザーを追加",
        "editTitle": "ユーザーの編集 {{username}}",
        "usernameLabel": "ユーザー名",
        "usernamePlaceholder": "ユーザー名",
        "passwordLabel": "パスワード",
        "passwordPlaceholder": "ユーザーの初期パスワード",
        "passwordHint": "パスワードは 8 文字以上である必要があります",
        "passwordNewLabel": "新しいパスワード",
        "passwordNewPlaceholder": "{{username}} の新しいパスワード",
        "bioLabel": "自己紹介",
        "bioPlaceholder": "ユーザーの自己紹介",
        "roleLabel": "ロール",
        "noteAfterCreate": "ユーザー作成後、初期ログイン情報でログインする必要があります。"
      },
      "confirm": {
        "suspend": {
          "title": "ユーザーを停止しますか？",
          "description": "{{username}} はログアウトされ、管理者が回復するまで再ログインできなくなります。",
          "confirm": "停止"
        },
        "unsuspend": {
          "title": "ユーザーを復元しますか？",
          "description": "{{username}} はこのインスタンスへ再ログインできます。",
          "confirm": "復元"
        },
        "delete": {
          "title": "ユーザーを削除しますか？",
          "description": "{{username}} はログアウトされ、この Athena インスタンスの利用が停止されます。元に戻せません。",
          "confirm": "削除"
        }
      },
      "toast": {
        "suspended": "ユーザーを停止しました。",
        "unsuspended": "ユーザーを再開しました。",
        "deleted": "ユーザーをシステムから削除しました。"
      }
    },
    "workspaces": {
      "title": "インスタンスワークスペース",
      "description": "このインスタンスに存在するすべてのワークスペースです。ワークスペースを削除すると、関連するチャットと設定もすべて削除されます。",
      "create": "新しいワークスペース",
      "table": {
        "name": "名称",
        "link": "リンク",
        "users": "ユーザー",
        "createdOn": "作成日"
      },
      "modal": {
        "createTitle": "新規ワークスペース作成",
        "create": "ワークスペース作成",
        "namePlaceholder": "マイワークスペース",
        "noteAfterCreate": "管理者のみが新規ワークスペースを表示できます。作成後にユーザー追加が可能です。"
      },
      "actions": {
        "cancel": "キャンセル"
      },
      "confirm": {
        "delete": {
          "title": "ワークスペースを削除しますか？",
          "description": "{{workspaceName}} はこの Athena インスタンスで使用できなくなり、元に戻せません。",
          "confirm": "削除"
        }
      }
    },
    "invites": {
      "title": "招待",
      "description": "組織内のユーザーに対して受け入れ可能な招待リンクを作成します。各招待は1人のユーザーのみ使用できます。",
      "create": "招待リンクを作成",
      "publicRegistration": {
        "title": "公開登録を許可",
        "description": "有効時、ログイン画面に「アカウント作成」が表示され、公開登録では一般ユーザーのみ作成できます。",
        "enabled": "有効",
        "disabled": "無効",
        "enableAction": "有効化",
        "disableAction": "無効化"
      },
      "table": {
        "status": "ステータス",
        "role": "ロール",
        "acceptedBy": "受諾者",
        "createdBy": "作成者",
        "expires": "期限",
        "created": "作成日"
      },
      "noInvitations": "招待が見つかりません",
      "toasts": {
        "updateError": "公開登録設定の更新に失敗しました。",
        "updateEnabled": "公開登録を有効化しました。",
        "updateDisabled": "公開登録を無効化しました。"
      },
      "modal": {
        "title": "新規招待を作成",
        "roleLabel": "招待ロール",
        "copyToast": "招待リンクをクリップボードにコピーしました。",
        "note": "作成後、完全な招待リンクは1回のみコピー可能で、トークンはリストでは再表示されません。",
        "expiresLabel": "有効期限",
        "role": {
          "default": "一般ユーザー",
          "manager": "マネージャー",
          "admin": "管理者"
        },
        "expires": {
          "24": "24時間",
          "72": "3日",
          "168": "7日"
        },
        "autoAssignTitle": "招待ユーザーをワークスペースへ自動追加",
        "autoAssignDescription": "必要に応じて、選択したワークスペースへ自動的にユーザーを割り当てられます。初期状態では、ユーザーはワークスペースを持ちません。",
        "cancel": "キャンセル",
        "create": "招待を作成",
        "close": "閉じる",
        "createError": "招待の作成に失敗しました。もう一度お試しください。"
      },
      "status": {
        "pending": "保留中",
        "accepted": "受諾済み",
        "claimed": "引き取り済み",
        "revoked": "失効"
      },
      "role": {
        "default": "一般ユーザー",
        "manager": "マネージャー",
        "admin": "管理者"
      },
      "deletedUser": "削除済みユーザー",
      "confirm": {
        "disable": {
          "title": "招待を無効化しますか？",
          "description": "無効化すると、この招待は再利用できず、元に戻せません。",
          "confirm": "無効化"
        }
      }
    }
  },
  "scheduledJobs": {
    "title": "予定されている作業",
    "enableNotifications": "求人情報の通知をブラウザで許可する",
    "description": "定期的に実行されるAIタスクを作成します。これらのタスクは、指定されたスケジュールに従って実行され、オプションのツールを使用してプロンプトを実行し、結果を保存してレビューします。",
    "newJob": "新しい仕事",
    "loading": "読み込み中...",
    "emptyTitle": "現時点で予定されている作業はありません。",
    "emptySubtitle": "まずは、簡単なものから始めてみましょう。",
    "table": {
      "name": "名前",
      "schedule": "スケジュール",
      "status": "ステータス",
      "lastRun": "最後の走行",
      "nextRun": "次回の開催",
      "actions": "行動"
    },
    "confirmDelete": "本当にこの予定された作業を削除してもよろしいですか？",
    "toast": {
      "deleted": "求人情報が削除されました",
      "triggered": "ジョブが正常に実行されました",
      "triggerFailed": "ジョブの実行が失敗しました",
      "triggerSkipped": "この仕事については、すでに作業が進んでいます。",
      "killed": "作業は正常に終了しました",
      "killFailed": "仕事をやめることができなかった"
    },
    "row": {
      "neverRun": "絶対に走らない",
      "viewRuns": "実行例",
      "runNow": "今すぐ行動を",
      "enable": "有効にする",
      "disable": "無効化",
      "edit": "編集",
      "delete": "削除"
    },
    "modal": {
      "titleEdit": "予定されたタスクの編集",
      "titleNew": "新規スケジュールされた作業",
      "nameLabel": "名前",
      "namePlaceholder": "例：デイリーニュースダイジェスト",
      "promptLabel": "指示",
      "promptPlaceholder": "「各実行時に実行する」という指示...",
      "scheduleLabel": "スケジュール",
      "modeBuilder": "建設業者",
      "modeCustom": "オーダーメイド",
      "cronPlaceholder": "Cron 形式の指定 (例: 0 9 * * *)",
      "currentSchedule": "現在のスケジュール：",
      "toolsLabel": "道具（任意）",
      "toolsDescription": "このタスクで使用できるエージェントツールを選択してください。 ツールが選択されていない場合、タスクはツールなしで実行されます。",
      "toolsSearch": "検索",
      "toolsNoResults": "該当するツールは見つかりませんでした。",
      "required": "必要",
      "requiredFieldsBanner": "求人を作成するには、必要なすべての項目を記入してください。",
      "cancel": "キャンセル",
      "saving": "保存中...",
      "updateJob": "求人情報の更新",
      "createJob": "求人を作成する",
      "jobUpdated": "求人情報が更新されました",
      "jobCreated": "雇用が創出された"
    },
    "builder": {
      "fallbackWarning": "このテキストは、視覚的に編集することはできません。元のテキストを維持するには、「カスタム」モードに切り替えてください。または、以下の項目を変更することで、このテキストを上書きできます。",
      "run": "走る",
      "frequency": {
        "minute": "1分ごとに",
        "hour": "時間ごと",
        "day": "毎日",
        "week": "毎週",
        "month": "毎月"
      },
      "every": "すべて",
      "minuteOne": "1分",
      "minuteOther": "{{count}} 分",
      "atMinute": "分単位で",
      "pastEveryHour": "過去の、1時間ごとに",
      "at": "～に",
      "on": "～について",
      "onDay": "ある日",
      "ofEveryMonth": "毎月",
      "weekdays": {
        "sun": "太陽",
        "mon": "月",
        "tue": "火曜日",
        "wed": "水曜日",
        "thu": "木曜日",
        "fri": "金曜日",
        "sat": "土曜日"
      }
    },
    "runHistory": {
      "back": "求人情報に戻る",
      "title": "実行履歴: {{name}}",
      "schedule": "スケジュール：",
      "emptyTitle": "現時点では、この仕事に対してまだ成果は出ていません。",
      "emptySubtitle": "現在ジョブを実行し、その結果を確認してください。",
      "runNow": "今すぐ実行",
      "table": {
        "status": "ステータス",
        "started": "開始",
        "duration": "期間",
        "error": "エラー"
      },
      "stopJob": "仕事の停止"
    },
    "runDetail": {
      "loading": "ロード実行の詳細を読み込んでいます...",
      "notFound": "指定されたプログラムが見つかりませんでした。",
      "back": "背面",
      "unknownJob": "不明な職種",
      "runHeading": "{{name}} — 実行: #{{id}}",
      "duration": "期間: {{value}}",
      "creating": "作成中...",
      "threadFailed": "スレッドの作成に失敗しました",
      "sections": {
        "prompt": "指示",
        "error": "エラー",
        "thinking": "考え ({{count}})",
        "toolCalls": "ツール呼び出し ({{count}})",
        "files": "ファイル ({{count}})",
        "response": "返答",
        "metrics": "指標"
      },
      "metrics": {
        "promptTokens": "プロンプトトークン:",
        "completionTokens": "完了トークン："
      },
      "stopJob": "求人停止",
      "killing": "停止…",
      "continueInThread": "チャットを続ける"
    },
    "toolCall": {
      "arguments": "主張：",
      "showResult": "結果を表示",
      "hideResult": "結果を非表示にする"
    },
    "file": {
      "unknown": "不明なファイル",
      "download": "ダウンロード",
      "downloadFailed": "ファイルのダウンロードに失敗しました",
      "types": {
        "powerpoint": "パワーポイント",
        "pdf": "PDFドキュメント",
        "word": "Wordドキュメント",
        "spreadsheet": "スプレッドシート",
        "generic": "ファイル"
      }
    },
    "status": {
      "completed": "完了",
      "failed": "失敗",
      "timed_out": "時間切れ",
      "running": "ランニング",
      "queued": "待ち列"
    }
  },
  "rerank": {
    "providers": {
      "native": {
        "name": "組み込みリランカー",
        "description": "Athenaに含まれるローカルシステムリランカーを使用します。APIキーやホスト型エンドポイントは不要です。"
      },
      "alibaba": {
        "name": "Alibaba DashScope",
        "description": "Alibaba Cloud DashScope qwen3 rerankを使用して、ベクター検索結果を並べ替えます。"
      }
    },
    "title": "リランクモデルの設定",
    "description": "ベクター検索結果のリランクに使用するプロバイダーとモデルを設定します。ワークスペースが精度最適化検索を使用する場合、このリランク設定が適用されます。",
    "provider": "リランクプロバイダー",
    "providerHint": "デフォルトでは組み込みリランカーを使用します。DashScope APIキーを取得し、ホスト型qwen3リランクを使用する場合にのみ、Alibaba Cloud DashScopeを選択してください。",
    "model": "リランクモデル",
    "nativeHelp": "組み込みリランカーはシステムネイティブのリランクモデルを通じてローカルで実行されるため、APIキー、ベースURL、モデルフィールドは不要です。これはAlibaba DashScopeリランクが設定される前のデフォルトモードです。",
    "help": "Alibaba DashScopeリランクは、ベクター検索の候補をDashScopeリランクエンドポイントに送信し、クエリとの関連性に基づいて並べ替えます。DashScope APIキー、ベースURL、モデル名を指定してください。",
    "save": "変更を保存",
    "saving": "保存中..."
  },
  "ocr": {
    "providers": {
      "none": {
        "name": "なし",
        "description": "ホスト型OCRモデルを使用しません。スキャンされたドキュメントは外部OCRを自動的に呼び出しません。"
      },
      "alibaba": {
        "name": "Alibaba DashScope",
        "description": "Alibaba Cloud DashScope qwen-vl-ocrを使用して、画像やスキャンされたテキストを認識します。"
      }
    },
    "title": "OCRモデルの設定",
    "description": "リーダーがスキャンしたPDFや画像からテキストを認識するために使用するプロバイダーとモデルを設定します。",
    "provider": "OCRプロバイダー",
    "providerHint": "ホスト型OCRはデフォルトで無効です。DashScope APIキーを取得し、スキャンしたテキストにAlibaba OCRを使用する場合にのみ、Alibaba Cloud DashScopeを選択してください。",
    "model": "OCRモデル",
    "noneHelp": "ホスト型OCRモデルは呼び出されません。リーダーは既存のテキストレイヤーとローカル解析結果を引き続き使用できますが、スキャンされたPDFや画像のOCR後処理は未設定のままです。",
    "help": "Alibaba DashScope OCRは、認識が必要な画像コンテンツをDashScopeのOpenAI互換エンドポイントに送信します。DashScope APIキー、ベースURL、モデル名を指定してください。",
    "save": "変更を保存",
    "saving": "保存中...",
    "saved": "OCRモデル設定が保存されました。",
    "saveError": "OCRモデル設定の保存に失敗しました: {{error}}"
  },
  "batch-jobs": {
    "table": {
      "job-id": "ジョブID",
      "workspace": "ワークスペース",
      "status": "ステータス",
      "graph": "ナレッジグラフ",
      "retry-count": "再試行回数",
      "next-retry": "次の再試行",
      "created": "作成日時",
      "updated": "更新日時",
      "error": "最終エラー",
      "action": "操作"
    },
    "retry": {
      "label": "再試行",
      "working": "再試行中...",
      "started": "バッチジョブのポーリングを再開しました。",
      "failed": "バッチジョブのポーリングを再開できませんでした。"
    },
    "graph": {
      "status": {
        "not_started": "未開始",
        "pending": "保留中",
        "processing": "処理中",
        "completed": "完了",
        "partial_failed": "一部失敗",
        "failed": "失敗",
        "unknown": "不明"
      }
    },
    "title": "バッチジョブ",
    "description": "非同期ドキュメント埋め込みジョブを確認します。"
  },
  "wechat": {
    "enabled": {
      "title": "WeChatコネクタを有効にする",
      "description": "公式ブリッジが設定されている場合、このAthenaインスタンスがWeChatコネクタを使用できるようにします。"
    },
    "qr": {
      "placeholder": "QRコードを生成し、WeChatでスキャンして接続します。",
      "generate": "QRコードを生成/更新",
      "alt": "WeChatログインQRコード",
      "open-link-helper": "QRコードをスキャンできない場合は、ブラウザでこのリンクを開いてください。"
    },
    "status": {
      "title": "ログインステータス",
      "disconnected": "未接続",
      "pending_scan": "スキャン待ち",
      "connected": "接続済み",
      "expired": "期限切れ",
      "connected-hint": "接続済みです。新しいQRコードをスキャンする場合は、先に切断してください。",
      "disconnecting-hint": "OpenClawログインセッションを切断してクリーンアップしています..."
    },
    "profile": {
      "title": "WeChatユーザー",
      "avatar": "WeChatアバター",
      "nickname": "ニックネーム",
      "wxid": "wxid/openid",
      "openid": "openid/account",
      "last-connected": "最終接続日時",
      "placeholder": "利用不可",
      "best-effort": "プロフィールフィールドはOpenClawメタデータからのみ読み取られます。資格情報はOpenClawとともにディスクに保存されたままです。"
    },
    "actions": {
      "relogin": "再ログイン",
      "disconnect": "切断",
      "disconnecting": "切断中..."
    },
    "toasts": {
      "save-failed": "WeChatコネクタ設定を保存できませんでした。",
      "qr-failed": "QRコードを生成できませんでした。",
      "status-failed": "WeChatログインステータスを更新できませんでした。",
      "disconnect-failed": "WeChatコネクタを切断できませんでした。"
    },
    "errors": {
      "openclaw_not_installed": "OpenClaw CLIが見つかりませんでした。OPENCLAW_BINを設定するか、最初にOpenClawをインストールしてください。",
      "plugin_missing": "OpenClaw Weixinプラグインがインストールされていません。",
      "environment_incomplete": "OpenClaw Weixin環境が不完全であるか、書き込み可能ではありません。",
      "plugin_install_failed": "OpenClaw Weixinプラグインをインストールできませんでした。",
      "qr_generation_failed": "WeChat QRコードを生成できませんでした。",
      "login_status_failed": "WeChatログインステータスを読み取れませんでした。",
      "disconnect_failed": "OpenClaw Weixinを切断できませんでした。"
    },
    "title": "WeChatコネクタ",
    "description": "公式のTencent OpenClaw Weixin QRコードをスキャンしてWeChatを接続します。"
  },
  "advancedGateway": {
    "enabled": {
      "title": "アドバンストゲートウェイコネクタを有効にする",
      "description": "実装後に外部ゲートウェイサービスを使用できるようにします。"
    },
    "notes": {
      "title": "ゲートウェイのセキュリティメモ",
      "api-secret": "APIシークレットは、外部ゲートウェイがAthena webhook用のHMAC署名を生成するために使用されます。",
      "gateway-url": "ゲートウェイURLは、現在、外部ゲートウェイサービスのアドレスとして記録されています。",
      "no-wechat-state": "WeChatのログイン状態、クッキー、トークン、ローカル資格情報はAthenaに保存されません。",
      "external-gateway": "実際のWeChatログイン、メッセージ受信、メッセージ送信は、外部ゲートウェイ、Clawbot、またはOpenClaw WeChatプラグインによって処理されます。"
    },
    "fields": {
      "gateway-url": "ゲートウェイURL",
      "api-key": "APIキー",
      "api-secret": "APIシークレット",
      "secret-saved": "保存済み。変更しない場合は空白のままにしてください。"
    },
    "actions": {
      "test": "接続テスト",
      "save": "設定を保存"
    },
    "toasts": {
      "saved": "アドバンストゲートウェイコネクタの設定を保存しました。",
      "tested": "アドバンストゲートウェイの接続テストが完了しました。",
      "save-failed": "Advanced Gateway コネクタ設定の保存に失敗しました。",
      "test-failed": "Advanced Gateway コネクタのテストに失敗しました。"
    },
    "title": "アドバンストゲートウェイコネクタ",
    "description": "Clawbot、Python、Rust、その他のメッセージリレーサービス用にカスタム外部ゲートウェイを設定します。"
  },
  "email_verification_errors": {
    "not_found": "有効な確認コードが見つかりません。新しいコードをリクエストしてください。",
    "invalid_format": "6桁の確認コードを入力してください。",
    "expired": "この確認コードは有効期限が切れています。新しいコードをリクエストしてください。",
    "consumed": "この確認コードは既に使用されています。新しいコードをリクエストしてください。",
    "attempts_exceeded": "試行回数が多すぎます。新しい確認コードをリクエストしてください。",
    "mismatch": "確認コードが正しくありません。最新のメールをご確認ください。",
    "resend_cooldown": "別の確認コードをリクエストする前にお待ちください。",
    "smtp_not_configured": "メールSMTPが設定されていません。",
    "default": "検証に失敗しました。新しいコードをリクエストして、もう一度お試しください。"
  }
}

export default TRANSLATIONS;
