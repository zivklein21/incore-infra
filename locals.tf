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
    adminCancelRegistration            = { method = "POST" }
    adminChangeHypBillingAgreementPlan = { method = "POST" }
    adminChargeHypAgreementNow         = { method = "POST" }
    adminCheckEmailAvailable           = { method = "ANY" }
    adminClearMemberSavedCard          = { method = "POST" }
    adminClearMemberships              = { method = "POST" }
    adminCreateUser                    = { method = "POST" } # IAM-privileged (AdminCreateUser) — see handler comment
    adminDeleteClassType               = { method = "POST" }
    adminDeleteMember                  = { method = "POST" }
    adminDeleteMemberCredit            = { method = "POST" }
    adminDeleteNotificationTemplate    = { method = "POST" }
    adminDeleteProduct                 = { method = "POST" }
    adminDeleteS3Object                = { method = "POST" } # Admin Portal: Assets Manager
    adminEvictFutureRegistrations      = { method = "POST" }
    adminGetDashboardMetrics           = { method = "ANY" } # Admin Portal: Dashboard
    adminGetLambdaLogs                 = { method = "ANY" } # Admin Portal: Logs Viewer
    adminGetMemberships                = { method = "ANY" }
    adminGetS3ObjectMetadata           = { method = "ANY" }  # Admin Portal: Assets Manager
    adminGetS3UploadUrl                = { method = "POST" } # Admin Portal: Assets Manager
    adminGetSystemAlerts               = { method = "ANY" }  # Admin Portal: Dashboard
    adminGetSystemConfig               = { method = "ANY" }  # Admin Portal: Config screen
    adminGetTableItem                  = { method = "ANY" }  # Admin Portal: Data Viewer
    adminGetTableShape                 = { method = "ANY" }  # Admin Portal: Data Viewer filter discovery
    adminGrantCustomMigration          = { method = "POST" }
    adminGrantMembership               = { method = "POST" }
    adminListHypBillingAgreements      = { method = "ANY" }
    adminListHypOrders                 = { method = "ANY" }
    adminListLogGroups                 = { method = "ANY" } # Admin Portal: Logs Viewer
    adminListS3Objects                 = { method = "ANY" } # Admin Portal: Assets Manager
    adminQueryTableItems               = { method = "ANY" } # Admin Portal: Data Viewer
    adminRefundMemberLastPayment       = { method = "POST" }
    adminRefundOrder                   = { method = "POST" }
    adminRejectWaitlist                = { method = "POST" }
    adminRemoveLegalCancellation       = { method = "POST" }
    adminRevertLateCancellation        = { method = "POST" }
    adminRevokeParentalConsent         = { method = "POST" }
    adminRunHypBillingCycle            = { method = "POST" }
    adminSaveBirthdayCampaign          = { method = "POST" }
    adminSaveClassType                 = { method = "POST" }
    adminSaveNotificationTemplate      = { method = "POST" }
    adminSaveProduct                   = { method = "POST" }
    adminSaveRegistrationFormConfig    = { method = "POST" }
    adminSaveSystemConfig              = { method = "POST" } # Admin Portal: Config screen
    adminSaveTermsOfServiceContent     = { method = "POST" }
    adminSendBirthdayGiftNow           = { method = "POST" }
    adminSendClassMessage              = { method = "POST" }
    adminSetForceShowPaymentButton     = { method = "POST" }
    adminSetHypBillingAgreementStatus  = { method = "POST" }
    adminSetMemberAlert                = { method = "POST" }
    adminUpdateMemberCredit            = { method = "POST" }
    adminUpdateMembership              = { method = "POST" }
    adminUpdateMemberMembershipBadge   = { method = "POST" }
    adminUpdateMemberPersonal          = { method = "POST" }
    adminUpdateMemberWallet            = { method = "POST" }
    adminUpdateTableItem               = { method = "POST" } # Admin Portal: Data Viewer
    adminWhoAmI                        = { method = "ANY" }  # Admin Portal: auth-gate check
    bookClass                          = { method = "POST" }
    cancelBooking                      = { method = "POST" }
    cancelPolicyPreview                = { method = "POST" }
    closeSupportInquiry                = { method = "POST" }
    createClass                        = { method = "POST" }
    createHypCardUpdatePage            = { method = "POST" }
    createHypPaymentPage               = { method = "POST" }
    createHypTokenPurchase             = { method = "POST" }
    createSupportInquiry               = { method = "POST" }
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
    getClasses                         = { method = "ANY" }
    getClassTypes                      = { method = "ANY" }
    getFileUrl                         = { method = "ANY" }
    getHypOrderStatus                  = { method = "ANY" }
    getInquiryMessages                 = { method = "ANY" }
    getMemberBookingSources            = { method = "ANY" }
    getMemberCancellations             = { method = "ANY" }
    getMemberDetail                    = { method = "ANY" }
    getMemberMembership                = { method = "ANY" }
    getMemberMessages                  = { method = "ANY" }
    getMyBillingAgreement              = { method = "ANY" }
    getMyInquiries                     = { method = "ANY" }
    getNotificationTemplates           = { method = "ANY" }
    getNotificationTimingSettings      = { method = "ANY" }
    getPaymentPolicySettings           = { method = "ANY" }
    getProducts                        = { method = "ANY" }
    getProfile                         = { method = "ANY" }
    getRegistrationFormConfig          = { method = "ANY" }
    getSupportSettings                 = { method = "ANY" }
    getTermsOfServiceContent           = { method = "ANY" }
    getUploadUrl                       = { method = "POST" }
    getWallet                          = { method = "ANY" }
    grantPunchCard                     = { method = "POST" }
    joinWaitlist                       = { method = "POST" }
    leaveWaitlist                      = { method = "POST" }
    markAdminNotificationRead          = { method = "POST" }
    renewSubscriptionWithToken         = { method = "POST" }
    resizeProfilePhoto                 = { method = "POST" }
    saveClassSeries                    = { method = "POST" }
    saveScheduleAlertSettings          = { method = "POST" }
    saveSupportSettings                = { method = "POST" }
    sendSupportMessage                 = { method = "POST" }
    sendWelcomeEmail                   = { method = "POST" }
    submitHealthDeclaration            = { method = "POST" }
    submitParentalConsent              = { method = "POST" }
    submitRegistrationForm             = { method = "POST" }
    swapClass                          = { method = "POST" }
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

  # EventBridge Scheduler — cron expressions in AWS's 6-field syntax,
  # evaluated in Asia/Jerusalem (schedule_expression_timezone), matching the
  # original Firebase onSchedule({ timeZone: 'Asia/Jerusalem' }) configs
  # exactly rather than requiring manual UTC/DST conversion.
  scheduled_functions = {
    expireProducts             = "cron(0 2 * * ? *)"       # 02:00 daily
    clearUsedPunchCards        = "cron(5 0 1 * ? *)"       # 00:05 on the 1st
    distributeBirthdayRewards  = "cron(10 0 1 * ? *)"      # 00:10 on the 1st
    weekendSessionsRoutine     = "cron(59 23 ? * SAT *)"   # Saturday 23:59
    monthEndRollover           = "cron(59 23 28-31 * ? *)" # 23:59 on days 28-31 (last-day guard inside)
    subscriptionExpiryAlert    = "cron(0 20 28-31 * ? *)"  # 20:00 on days 28-31 (last-day guard inside)
    classReminderEngine        = "cron(0 * * * ? *)"       # top of every hour
    scheduleAlertRoutine       = "cron(0/10 * * * ? *)"    # every 10 minutes
    sendMembershipReminders    = "cron(0 9 * * ? *)"       # 09:00 daily
    cleanupExpiredMessages     = "cron(0 * * * ? *)"       # hourly (TTL handles most of this — see README.md)
    processWaitlistTimeouts    = "cron(0/1 * * * ? *)"     # every minute
    chargeHypBillingAgreements = "cron(0 3 * * ? *)"       # 03:00 daily
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

  all_function_names = distinct(concat(
    keys(local.all_http_functions),
    keys(local.scheduled_functions),
    local.stream_functions,
    local.sqs_functions,
    [local.cors_preflight_function],
  ))
}
