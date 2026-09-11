# Classifies every migrated Lambda function by how it's invoked. Generated
# from the actual event-type each src/functions/*.ts handler imports (see
# the migration notes in README.md) — keep in sync if a handler's trigger
# type changes.

locals {
  # HTTP, behind the Cognito JWT authorizer (a real signed-in member/admin).
  http_authenticated_functions = {
    acceptPolicies                     = { method = "POST" }
    adminAddMemberCredit               = { method = "POST" }
    adminAddToClass                    = { method = "POST" }
    adminAddTrialToClass               = { method = "POST" }
    adminApproveWaitlist               = { method = "POST" }
    adminAssignGroup                   = { method = "POST" } # FORCA Coach feature: assign a trainee to a Group
    adminCancelRegistration            = { method = "POST" }
    adminChangeHypBillingAgreementPlan = { method = "POST" }
    adminChargeHypAgreementNow         = { method = "POST" }
    adminCheckEmailAvailable           = { method = "ANY" }
    adminClearMemberSavedCard          = { method = "POST" }
    adminClearMemberships              = { method = "POST" }
    adminCreateUser                    = { method = "POST" } # IAM-privileged (AdminCreateUser) — see handler comment
    adminDeleteClassType               = { method = "POST" }
    adminDeleteCoach                   = { method = "POST" } # FORCA Coach feature
    adminDeleteEquipment               = { method = "POST" } # FORCA Coach feature
    adminDeleteExtraTraining           = { method = "POST" } # FORCA Extra Training feature
    adminDeleteGroup                   = { method = "POST" } # FORCA Coach feature
    adminDeleteMember                  = { method = "POST" }
    adminDeleteMemberCredit            = { method = "POST" }
    adminDeleteMerchProduct            = { method = "POST" } # FORCA Merch Store feature
    adminDeleteNotificationTemplate    = { method = "POST" }
    adminDeleteProduct                 = { method = "POST" }
    adminDeleteRecurringSession        = { method = "POST" } # FORCA Coach feature
    adminDeleteS3Object                = { method = "POST" } # Admin Portal: Assets Manager
    adminDeleteTrainingType            = { method = "POST" } # FORCA Coach feature
    adminEvictFutureRegistrations      = { method = "POST" }
    adminGetDashboardMetrics           = { method = "ANY" } # Admin Portal: Dashboard
    adminGetLambdaLogs                 = { method = "ANY" } # Admin Portal: Logs Viewer
    adminGetMemberFamilyInfo           = { method = "ANY" } # Family Accounts: MemberDetailsScreen's Family card
    adminGetMemberships                = { method = "ANY" }
    adminGetS3ObjectMetadata           = { method = "ANY" }  # Admin Portal: Assets Manager
    adminGetS3UploadUrl                = { method = "POST" } # Admin Portal: Assets Manager
    adminGetSystemAlerts               = { method = "ANY" }  # Admin Portal: Dashboard
    adminGetSystemConfig               = { method = "ANY" }  # Admin Portal: Config screen
    adminGetTableItem                  = { method = "ANY" }  # Admin Portal: Data Viewer
    adminGetTableShape                 = { method = "ANY" }  # Admin Portal: Data Viewer filter discovery
    adminGrantCustomMigration          = { method = "POST" }
    adminGrantMembership               = { method = "POST" }
    adminLinkFamilyMember              = { method = "POST" } # Family Accounts: link a parent/child pair
    adminListFamilyLinks               = { method = "ANY" }  # Family Accounts: Admin Portal household list
    adminListGroups                    = { method = "ANY" }  # FORCA Coach feature
    adminListHypBillingAgreements      = { method = "ANY" }
    adminListHypOrders                 = { method = "ANY" }
    adminListLogGroups                 = { method = "ANY" } # Admin Portal: Logs Viewer
    adminListMerchProducts             = { method = "GET" } # FORCA Merch Store feature
    adminListRecurringSessions         = { method = "GET" } # FORCA Coach feature
    adminListS3Objects                 = { method = "ANY" } # Admin Portal: Assets Manager
    adminQueryTableItems               = { method = "ANY" } # Admin Portal: Data Viewer
    adminRefundMemberLastPayment       = { method = "POST" }
    adminRefundMerchOrder              = { method = "POST" } # FORCA Merch Store feature
    adminRefundOrder                   = { method = "POST" }
    adminRejectWaitlist                = { method = "POST" }
    adminRemoveLegalCancellation       = { method = "POST" }
    adminResetMemberPassword           = { method = "POST" } # IAM-privileged (AdminSetUserPassword) — see handler comment
    adminRevertLateCancellation        = { method = "POST" }
    adminRevokeParentalConsent         = { method = "POST" }
    adminRunHypBillingCycle            = { method = "POST" }
    adminSaveBirthdayCampaign          = { method = "POST" }
    adminSaveClassType                 = { method = "POST" }
    adminSaveEquipment                 = { method = "POST" } # FORCA Coach feature
    adminSaveExtraTraining             = { method = "POST" } # FORCA Extra Training feature
    adminSaveGroup                     = { method = "POST" } # FORCA Coach feature
    adminSaveMerchProduct              = { method = "POST" } # FORCA Merch Store feature
    adminSaveNotificationTemplate      = { method = "POST" }
    adminSaveProduct                   = { method = "POST" }
    adminSaveRecurringSession          = { method = "POST" } # FORCA Coach feature
    adminSaveRegistrationFormConfig    = { method = "POST" }
    adminSaveSystemConfig              = { method = "POST" } # Admin Portal: Config screen
    adminSaveTermsOfServiceContent     = { method = "POST" }
    adminSaveTrainingType              = { method = "POST" } # FORCA Coach feature
    adminSendBirthdayGiftNow           = { method = "POST" }
    adminSendClassMessage              = { method = "POST" }
    adminSetForceShowPaymentButton     = { method = "POST" }
    adminSetHypBillingAgreementStatus  = { method = "POST" }
    adminSetMemberAlert                = { method = "POST" }
    adminUnlinkFamilyMember            = { method = "POST" } # Family Accounts: remove a parent/child link
    adminUpdateCoachPersonal           = { method = "POST" } # FORCA Coach feature
    adminUpdateMemberCredit            = { method = "POST" }
    adminUpdateMembership              = { method = "POST" }
    adminUpdateMemberMembershipBadge   = { method = "POST" }
    adminUpdateMemberPersonal          = { method = "POST" }
    adminUpdateMemberWallet            = { method = "POST" }
    adminUpdatePendingMembership       = { method = "POST" }
    adminUpdateTableItem               = { method = "POST" } # Admin Portal: Data Viewer
    adminWhoAmI                        = { method = "ANY" }  # Admin Portal: auth-gate check
    bookClass                          = { method = "POST" }
    cancelBooking                      = { method = "POST" }
    cancelPolicyPreview                = { method = "POST" }
    closeSession                       = { method = "POST" } # FORCA Coach feature
    closeSupportInquiry                = { method = "POST" }
    createClass                        = { method = "POST" }
    createHypCardUpdatePage            = { method = "POST" }
    createHypPaymentPage               = { method = "POST" }
    createHypTokenPurchase             = { method = "POST" }
    createMerchPaymentPage             = { method = "POST" } # FORCA Merch Store feature
    createSupportInquiry               = { method = "POST" }
    createTrainingSession              = { method = "POST" } # FORCA Coach feature: admin-only, auto-registers a Group
    declareAttendance                  = { method = "POST" } # FORCA Coach feature: trainee's own declared attendance
    deleteClass                        = { method = "POST" }
    deleteClassSeries                  = { method = "POST" }
    deleteMemberMessage                = { method = "POST" }
    deleteSupportInquiry               = { method = "POST" }
    dismissMemberAlert                 = { method = "POST" }
    getActiveMembership                = { method = "ANY" }
    getActivityHistory                 = { method = "ANY" }
    getAdminNotifications              = { method = "ANY" }
    getAllInquiries                    = { method = "ANY" }
    getAllMemberMemberships            = { method = "ANY" }
    getAllMembers                      = { method = "ANY" }
    getBirthdayCampaign                = { method = "ANY" }
    getCancellationPolicySettings      = { method = "ANY" }
    getClassDetail                     = { method = "ANY" }
    getClassMembers                    = { method = "ANY" }
    getClassParticipants               = { method = "ANY" } # Client-facing public roster (see getClassMembers for admin equivalent)
    getClasses                         = { method = "ANY" }
    getClassTypes                      = { method = "ANY" }
    getCoachOptions                    = { method = "GET" } # FORCA Coach feature: admin-only
    getCoachSessions                   = { method = "ANY" } # FORCA Coach feature: isCoachOrAdmin-gated
    getEquipment                       = { method = "GET" } # FORCA Coach feature
    getExtraTraining                   = { method = "GET" } # FORCA Extra Training feature
    getFileUrl                         = { method = "ANY" }
    getForcaMerchProducts              = { method = "GET" } # FORCA Merch Store feature
    getHypOrderStatus                  = { method = "ANY" }
    getInquiryMessages                 = { method = "ANY" }
    getMemberBookingSources            = { method = "ANY" }
    getMemberCancellations             = { method = "ANY" }
    getMemberDetail                    = { method = "ANY" }
    getMemberMembership                = { method = "ANY" }
    getMemberMessages                  = { method = "ANY" }
    getMyBillingAgreement              = { method = "ANY" }
    getMyInquiries                     = { method = "ANY" }
    getMyTrainingSessions              = { method = "GET" } # FORCA Coach feature: trainee's own upcoming sessions
    getNotificationTemplates           = { method = "ANY" }
    getNotificationTimingSettings      = { method = "ANY" }
    getPaymentPolicySettings           = { method = "ANY" }
    getProducts                        = { method = "ANY" }
    getProfile                         = { method = "ANY" }
    getRegistrationFormConfig          = { method = "ANY" }
    getSupportSettings                 = { method = "ANY" }
    getTermsOfServiceContent           = { method = "ANY" }
    getTrainingHistory                 = { method = "GET" } # FORCA Coach feature: admin-only
    getTrainingTypes                   = { method = "GET" } # FORCA Coach feature
    getUploadUrl                       = { method = "POST" }
    getWallet                          = { method = "ANY" }
    grantPunchCard                     = { method = "POST" }
    joinWaitlist                       = { method = "POST" }
    leaveWaitlist                      = { method = "POST" }
    listMyFamily                       = { method = "ANY" }  # Family Accounts: a member's own linked children
    markActualAttendance               = { method = "POST" } # FORCA Coach feature: the coach's only write action
    markAdminNotificationRead          = { method = "POST" }
    renewSubscriptionWithToken         = { method = "POST" }
    resizeProfilePhoto                 = { method = "POST" }
    returnSessionEquipment             = { method = "POST" } # FORCA Coach feature
    saveClassSeries                    = { method = "POST" }
    saveScheduleAlertSettings          = { method = "POST" }
    saveSupportSettings                = { method = "POST" }
    sendSupportMessage                 = { method = "POST" }
    sendWelcomeEmail                   = { method = "POST" }
    submitHealthDeclaration            = { method = "POST" }
    submitParentalConsent              = { method = "POST" }
    submitRegistrationForm             = { method = "POST" }
    swapClass                          = { method = "POST" }
    switchProfile                      = { method = "POST" } # Family Accounts: parent -> linked child token swap
    toggleSessionEquipment             = { method = "POST" } # FORCA Coach feature
    triggerTemplateAlert               = { method = "POST" }
    updateClass                        = { method = "POST" }
    updateProfile                      = { method = "POST" }
    updateProfilePhoto                 = { method = "POST" }
    updatePhotoConsent                 = { method = "POST" }
    updatePushToken                    = { method = "POST" }
  }

  # HTTP, NOT behind the JWT authorizer — either a pre-login flow (OTP), an
  # external webhook authenticated by its own shared secret, or (flagged
  # during migration, see README.md) an endpoint the original Firebase code
  # never authenticated at all. Preserved as-is; several of these are
  # follow-up candidates to move behind real auth.
  http_public_functions = {
    activateProratedSubscription     = { method = "POST" } # SECURITY: no auth in original — see README.md
    adminBackfillResizeProfilePhotos = { method = "POST" } # auth: x-backfill-secret header
    confirmWaitlistSpot              = { method = "POST" } # SECURITY: no auth in original
    hypPaymentCallback               = { method = "GET" }  # HYP browser redirect — must stay public. Legacy combined endpoint, kept live until the HYP masof portal's Success/Failed Transaction URLs are switched to the two below.
    hypPaymentSuccessCallback        = { method = "GET" }  # HYP browser redirect — must stay public. Configure as masof "Success page URL".
    hypPaymentFailureCallback        = { method = "GET" }  # HYP browser redirect — must stay public. Configure as masof "Failed Transaction" custom link.
    rejectWaitlistOffer              = { method = "POST" } # SECURITY: no auth in original
    sendBookCancelNotification       = { method = "POST" } # SECURITY: no auth in original
    sendClassCancelNotifications     = { method = "POST" } # SECURITY: no auth in original
    sendOtp                          = { method = "POST" } # pre-login forgot-password flow
    testClassReminder                = { method = "ANY" }  # manual test/debug endpoint
    testMembershipReminder           = { method = "GET" }  # manual test/debug endpoint
    triggerWaitlistOffer             = { method = "POST" } # SECURITY: no auth in original
    verifyOtp                        = { method = "POST" } # pre-login forgot-password flow
  }

  all_http_functions = merge(local.http_authenticated_functions, local.http_public_functions)

  # Only method="ANY" routes actually swallow OPTIONS and need a dedicated
  # preflight route (see api_gateway.tf's aws_apigatewayv2_route.cors_preflight)
  # — a GET/POST-only route never matches OPTIONS, so it's already covered by
  # the API's own cors_configuration block with no extra route required.
  # Keeping this filtered (instead of covering every function) is what keeps
  # total route count under API Gateway v2's per-API route quota.
  cors_preflight_functions = { for k, v in local.all_http_functions : k => v if v.method == "ANY" }

  # EventBridge Scheduler — cron expressions in AWS's 6-field syntax,
  # evaluated in Asia/Jerusalem (schedule_expression_timezone), matching the
  # original Firebase onSchedule({ timeZone: 'Asia/Jerusalem' }) configs
  # exactly rather than requiring manual UTC/DST conversion.
  scheduled_functions = {
    expireProducts                 = "cron(0 2 * * ? *)"       # 02:00 daily
    activatePendingMemberships     = "cron(5 3 * * ? *)"       # 03:05 daily (see activatePendingMemberships.ts for why not 01:00)
    clearUsedPunchCards            = "cron(5 0 1 * ? *)"       # 00:05 on the 1st
    distributeBirthdayRewards      = "cron(10 0 1 * ? *)"      # 00:10 on the 1st
    weekendSessionsRoutine         = "cron(59 23 ? * THU *)"   # Thursday 23:59 — before the Fri/Sat no-class weekend
    monthEndRollover               = "cron(59 23 28-31 * ? *)" # 23:59 on days 28-31 (last-day guard inside)
    subscriptionExpiryAlert        = "cron(0 20 28-31 * ? *)"  # 20:00 on days 28-31 (last-day guard inside)
    classReminderEngine            = "cron(0 * * * ? *)"       # top of every hour
    scheduleAlertRoutine           = "cron(0/10 * * * ? *)"    # every 10 minutes
    sendMembershipReminders        = "cron(0 9 * * ? *)"       # 09:00 daily
    cleanupExpiredMessages         = "cron(0 * * * ? *)"       # hourly (TTL handles most of this — see README.md)
    processWaitlistTimeouts        = "cron(0/1 * * * ? *)"     # every minute
    chargeHypBillingAgreements     = "cron(0 3 * * ? *)"       # 03:00 daily
    checkUnreturnedEquipmentAlerts = "cron(0 * * * ? *)"       # hourly — FORCA Coach feature
  }

  # DynamoDB Streams consumers — every one of these must filter internally
  # by PK/SK since the stream carries change events for the whole table.
  stream_functions = [
    "processMail",
    "onMemberDeleted",
    "onMessageCreated",
    "onSupportMessageCreated",
    "onClassDeleted",
    "onClassBookingChanged",
  ]

  # SQS-triggered — currently just the Admin Portal's DLQ consumer (see
  # dlq.tf), which turns a failed async Lambda invocation into a
  # SystemAlertItem the Dashboard's alert feed can show.
  sqs_functions = [
    "processDlqMessage",
  ]

  # Shared no-op OPTIONS handler — see api_gateway.tf's aws_apigatewayv2_route.cors_preflight
  # and corsPreflight.ts for why every path needs its own unauthenticated
  # OPTIONS route. Not part of all_http_functions: it's deployed once here
  # purely so its Lambda exists, and wired to N routes explicitly in
  # api_gateway.tf instead of the usual one-function-one-route mapping.
  cors_preflight_function = "corsPreflight"

  # Cognito User Pool custom-auth triggers (Family Accounts' switchProfile.ts
  # flow — see cognito.tf's lambda_config). Invoked directly by Cognito, not
  # via API Gateway, so — like cors_preflight_function above — these are
  # built here (for a Lambda to exist) but deliberately excluded from
  # all_http_functions/http_authenticated_functions so no route is created.
  cognito_custom_auth_functions = [
    "cognitoDefineAuthChallenge",
    "cognitoCreateAuthChallenge",
    "cognitoVerifyAuthChallengeResponse",
  ]

  all_function_names = distinct(concat(
    keys(local.all_http_functions),
    keys(local.scheduled_functions),
    local.stream_functions,
    local.sqs_functions,
    [local.cors_preflight_function],
    local.cognito_custom_auth_functions,
  ))
}
