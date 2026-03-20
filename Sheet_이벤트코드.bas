' 이 코드를 각 시트에 직접 붙여넣으세요 (Alt+F11 → 시트 더블클릭)

Private Sub Worksheet_BeforeRightClick(ByVal Target As Range, Cancel As Boolean)
    Dim cellText As String
    Dim names As Variant
    Dim firstName As String
    
    Cancel = True
    
    cellText = Trim(CStr(Target.Value))
    If cellText = "" Then
        Call ClearHighlights
        Exit Sub
    End If
    
    names = GetKoreanNames(cellText)
    firstName = names(0)
    
    If firstName = "" Then
        Call ClearHighlights
        Exit Sub
    End If
    
    If mHighlightedName = firstName Then
        Call ClearHighlights
    Else
        Call HighlightPatient(firstName)
    End If
End Sub
