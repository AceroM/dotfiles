//go:build darwin && cgo

package theme

/*
#cgo LDFLAGS: -framework CoreFoundation
#include <CoreFoundation/CoreFoundation.h>
#include <stdlib.h>

static char *o_pref(const char *key, const char *app) {
	CFStringRef k = CFStringCreateWithCString(NULL, key, kCFStringEncodingUTF8);
	CFStringRef a = app ? CFStringCreateWithCString(NULL, app, kCFStringEncodingUTF8) : kCFPreferencesAnyApplication;
	CFPropertyListRef v = CFPreferencesCopyAppValue(k, a);
	CFRelease(k);
	if (app) CFRelease(a);
	if (!v) return NULL;
	char *out = NULL;
	if (CFGetTypeID(v) == CFStringGetTypeID()) {
		char buf[256];
		if (CFStringGetCString((CFStringRef)v, buf, sizeof buf, kCFStringEncodingUTF8)) out = strdup(buf);
	}
	CFRelease(v);
	return out;
}
*/
import "C"

import "unsafe"

// pref is a string preference: an app's (com.superlogical.rex), or the
// global domain's when app is empty.
func pref(key, app string) string {
	k := C.CString(key)
	defer C.free(unsafe.Pointer(k))
	var a *C.char
	if app != "" {
		a = C.CString(app)
		defer C.free(unsafe.Pointer(a))
	}
	v := C.o_pref(k, a)
	if v == nil {
		return ""
	}
	defer C.free(unsafe.Pointer(v))
	return C.GoString(v)
}
