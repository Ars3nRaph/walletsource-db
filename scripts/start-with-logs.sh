#!/bin/bash
# Start app and redirect logs to walletsource.log
npm start 2>&1 | tee walletsource.log
