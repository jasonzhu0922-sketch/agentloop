# No executable migration in WP-0

This directory deliberately contains no `cp_*` DDL. The later migration job will use the domain migration port and dialect fixtures; startup code must never run it.
